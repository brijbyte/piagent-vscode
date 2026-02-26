/**
 * Resolve VSCode Chat references (attached files, selections, etc.) into
 * a text block + optional images that can be forwarded to the agent session.
 *
 * For text files we only pass the path (and selection range if applicable) —
 * the agent can use its `read` tool to fetch contents when needed.
 * Images are sent inline as base64 since the agent can't read binary files.
 */

import type { ImageContent } from "@mariozechner/pi-ai";
import * as vscode from "vscode";
import { state } from "./state.mjs";

export interface ResolvedReferences {
	/** Text block describing the attached context (empty if no references) */
	contextText: string;
	/** Resolved image attachments (base64-encoded) */
	images: ImageContent[];
}

/** Image MIME types we can forward to the model */
const IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
]);

const IMAGE_EXTENSIONS: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
};

/**
 * Resolve all references attached to a chat request.
 */
export async function resolveReferences(
	references: readonly vscode.ChatPromptReference[],
	_workspaceFolder: string,
): Promise<ResolvedReferences> {
	const textParts: string[] = [];
	const images: ImageContent[] = [];

	for (const ref of references) {
		try {
			const result = await resolveOne(ref);
			if (result.text) textParts.push(result.text);
			if (result.image) images.push(result.image);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			state.outputChannel.appendLine(`[References] Failed to resolve ${ref.id}: ${msg}`);
			textParts.push(`<!-- Failed to resolve reference: ${ref.id} -->`);
		}
	}

	if (textParts.length === 0 && images.length === 0) {
		return { contextText: "", images };
	}

	const contextText =
		textParts.length > 0
			? "<attached_context>\n" + textParts.join("\n") + "\n</attached_context>"
			: "";
	return { contextText, images };
}

// ── Type helpers ─────────────────────────────────────────────────────────────

// VSCode chat reference values are plain objects — not actual vscode.Uri or
// vscode.Location instances.  We duck-type them based on observed shapes.
//
// Known shapes (from JSON.stringify of request.references):
//
// Image file:
//   value = { mimeType: "image/png", reference: { $mid, fsPath, path, scheme } }
//
// Regular file / prompt instruction:
//   value = { $mid, external, path, scheme }          (no fsPath)
//   value = { $mid, fsPath, path, scheme }             (with fsPath)
//
// Text selection (Location):
//   value = { uri: { ... }, range: { start: {line}, end: {line} } }
//
// Actual vscode.Uri / vscode.Location instances (rare in chat, but possible):
//   value instanceof vscode.Uri / vscode.Location

/** Anything with scheme + (fsPath | path) */
interface UriLike {
	scheme?: string;
	fsPath?: string;
	path?: string;
	external?: string;
	$mid?: number;
}

/** Image wrapper: { mimeType, reference: UriLike } */
interface ImageRefLike {
	mimeType: string;
	reference: UriLike;
}

/** Position in a range — either { line, character } object or a vscode.Position */
interface PositionLike {
	line: number;
	character: number;
}

/**
 * Location can arrive as:
 *   - vscode.Location: { uri, range: { start, end } }
 *   - Serialized:      { uri, range: [{ line, character }, { line, character }] }
 */
interface LocationLike {
	uri: UriLike;
	range: { start: PositionLike; end: PositionLike } | [PositionLike, PositionLike];
}

function isUriLike(v: unknown): v is UriLike {
	if (v instanceof vscode.Uri) return true;
	if (typeof v !== "object" || v === null) return false;
	const obj = v as Record<string, unknown>;
	return (
		(typeof obj.scheme === "string" || typeof obj.$mid === "number") &&
		(typeof obj.fsPath === "string" || typeof obj.path === "string")
	);
}

function isImageRef(v: unknown): v is ImageRefLike {
	if (typeof v !== "object" || v === null) return false;
	const obj = v as Record<string, unknown>;
	return typeof obj.mimeType === "string" && typeof obj.reference === "object" && obj.reference !== null;
}

function isLocationLike(v: unknown): v is LocationLike {
	if (v instanceof vscode.Location) return true;
	if (typeof v !== "object" || v === null) return false;
	const obj = v as Record<string, unknown>;
	if (!isUriLike(obj.uri)) return false;
	// range can be { start, end } or [pos, pos]
	const range = obj.range;
	if (Array.isArray(range) && range.length === 2) return true;
	if (typeof range === "object" && range !== null) {
		const r = range as Record<string, unknown>;
		return typeof r.start === "object" && typeof r.end === "object";
	}
	return false;
}

/** Convert a duck-typed URI-like object to a real vscode.Uri. */
function toUri(v: UriLike): vscode.Uri {
	if (v instanceof vscode.Uri) return v;
	if (v.fsPath) return vscode.Uri.file(v.fsPath);
	if (v.external) return vscode.Uri.parse(v.external);
	if (v.path) return vscode.Uri.file(v.path);
	throw new Error("Cannot convert to Uri: no fsPath, external, or path");
}

// ── Internal ─────────────────────────────────────────────────────────────────

interface ResolveResult {
	text?: string;
	image?: ImageContent;
}

async function resolveOne(ref: vscode.ChatPromptReference): Promise<ResolveResult> {
	const { value } = ref;

	// Image wrapper: { mimeType: "image/png", reference: { fsPath, ... } }
	if (isImageRef(value)) {
		return resolveImage(value);
	}

	// Location: file + range (text selection)
	if (isLocationLike(value)) {
		return resolveLocation(value);
	}

	// URI-like: regular file or prompt instruction
	if (isUriLike(value)) {
		return resolveUri(value);
	}

	// Actual vscode.Uri (just in case)
	if (value instanceof vscode.Uri) {
		return resolveUri(value as unknown as UriLike);
	}

	// String: inline text, variable expansion, etc.
	if (typeof value === "string") {
		return { text: value };
	}

	// Unknown: best-effort serialize
	if (value !== null && value !== undefined) {
		return { text: JSON.stringify(value) };
	}

	return {};
}

async function resolveImage(ref: ImageRefLike): Promise<ResolveResult> {
	const uri = toUri(ref.reference);
	const relativePath = vscode.workspace.asRelativePath(uri, false);
	const mimeType = IMAGE_MIME_TYPES.has(ref.mimeType) ? ref.mimeType : "image/png";

	const data = await vscode.workspace.fs.readFile(uri);
	const base64 = Buffer.from(data).toString("base64");

	return {
		text: `- ${relativePath} (image, ${formatBytes(data.byteLength)})`,
		image: { type: "image", data: base64, mimeType },
	};
}

function resolveLocation(location: LocationLike): ResolveResult {
	const uri = toUri(location.uri);
	const relativePath = vscode.workspace.asRelativePath(uri, false);

	// Normalize range: array [start, end] or object { start, end }
	let start: PositionLike;
	let end: PositionLike;
	if (Array.isArray(location.range)) {
		[start, end] = location.range;
	} else {
		start = location.range.start;
		end = location.range.end;
	}

	// 1-based line:column for human / agent readability
	const startLine = start.line + 1;
	const startCol = start.character + 1;
	const endLine = end.line + 1;
	const endCol = end.character + 1;

	return {
		text: `- ${relativePath} (selection ${startLine}:${startCol}–${endLine}:${endCol})`,
	};
}

async function resolveUri(uriLike: UriLike): Promise<ResolveResult> {
	const uri = toUri(uriLike);
	const filePath = uri.fsPath;
	const relativePath = vscode.workspace.asRelativePath(uri, false);
	const ext = extname(filePath);

	// Check if it's an image by extension (fallback for URIs without the wrapper)
	const mimeType = IMAGE_EXTENSIONS[ext.toLowerCase()];
	if (mimeType) {
		const data = await vscode.workspace.fs.readFile(uri);
		const base64 = Buffer.from(data).toString("base64");

		return {
			text: `- ${relativePath} (image, ${formatBytes(data.byteLength)})`,
			image: { type: "image", data: base64, mimeType },
		};
	}

	// Text file: just mention the path — agent uses `read` tool when needed
	return { text: `- ${relativePath}` };
}

function extname(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? "" : path.slice(dot);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
