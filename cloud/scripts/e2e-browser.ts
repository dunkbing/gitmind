// Plays the user's browser in the end-to-end test: signs in (dev login),
// approves the consent page the CLI opened, and follows the redirect back to
// the CLI's local callback. Usage: bun e2e-browser.ts BASE LOGIN AUTHORIZE_URL
const [base, login, authorizeUrl] = process.argv.slice(2);
const jar = new Map<string, string>();
async function go(url: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
	if (init.method === "POST") headers.set("Origin", base);
	const res = await fetch(url, { ...init, headers, redirect: "manual" });
	for (const c of res.headers.getSetCookie()) {
		const [pair] = c.split(";");
		const i = pair.indexOf("=");
		jar.set(pair.slice(0, i), pair.slice(i + 1));
	}
	return res;
}
await go(`${base}/dev/login?login=${login}&next=/`);
if (process.env.SEARCH) {
	const search = await go(`${base}/w/${login}?q=${encodeURIComponent(process.env.SEARCH)}`);
	console.log("cloud search finds:", [...(await search.text()).matchAll(/<div class="meta">([^ <]+)/g)].map((m) => m[1]).join(", ") || "nothing");
	process.exit(0);
}
const consent = await go(authorizeUrl);
const html = await consent.text();
if (consent.status !== 200) throw new Error(`consent page: ${consent.status} ${html.slice(0, 300)}`);
console.log("consent page:", /<h1>(.*?)<\/h1>/.exec(html)?.[1]);
const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
const approved = await go(`${base}/authorize`, {
	method: "POST",
	headers: { "Content-Type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({ handle, decision: "approve" }).toString(),
});
const back = approved.headers.get("Location")!;
console.log("redirected to:", back.replace(/code=[^&]+/, "code=…"));
console.log("callback says:", (await (await fetch(back)).text()).trim());
