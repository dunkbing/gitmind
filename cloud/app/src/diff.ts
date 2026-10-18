// A line diff (longest common subsequence), for showing what an AI app
// changed in a note. Notes are short, so the simple quadratic version is
// plenty.

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
	const a = before ? before.replace(/\n$/, "").split("\n") : [];
	const b = after ? after.replace(/\n$/, "").split("\n") : [];
	if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
	// lcs[i][j]: length of the common subsequence of a[i:] and b[j:].
	const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ kind: "same", text: a[i] });
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: "del", text: a[i++] });
		else out.push({ kind: "add", text: b[j++] });
	}
	while (i < a.length) out.push({ kind: "del", text: a[i++] });
	while (j < b.length) out.push({ kind: "add", text: b[j++] });
	return out;
}

// hunks keeps changed lines with `context` unchanged lines around them;
// longer unchanged stretches become a gap marker (null).
export function hunks(lines: DiffLine[], context = 2): (DiffLine | null)[] {
	const keep = lines.map((l) => l.kind !== "same");
	const show = lines.map((_, i) => {
		for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) if (keep[k]) return true;
		return false;
	});
	const out: (DiffLine | null)[] = [];
	lines.forEach((l, i) => {
		if (show[i]) out.push(l);
		else if (out[out.length - 1] !== null) out.push(null);
	});
	if (out[0] === null) out.shift();
	if (out[out.length - 1] === null) out.pop();
	return out;
}
