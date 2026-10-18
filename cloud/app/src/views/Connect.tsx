// How to connect AI apps to this server.

import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { toast, useStore } from "../store";

function Box({ text }: { text: string }) {
	return (
		<div className="mt-2 flex items-start gap-2">
			<div className="box flex-1">{text}</div>
			<button className="btn-outline" title="Copy" onClick={() => navigator.clipboard.writeText(text).then(() => toast("Copied"))}>
				<Copy size={14} />
			</button>
		</div>
	);
}

function App({ name, children }: { name: string; children: ReactNode }) {
	return (
		<section className="card mt-4 p-5">
			<h2 className="font-serif text-[18px]">{name}</h2>
			<div className="mt-1 text-[14px]">{children}</div>
		</section>
	);
}

export function ConnectView() {
	const me = useStore((s) => s.me)!;
	const mcp = me.mcpUrl;
	return (
		<div className="mx-auto max-w-[760px] px-5 py-10 md:px-10">
			<h1 className="view-title">Connect your AI apps</h1>
			<p className="mt-2 text-[14.5px]">Every app connects to the same MCP endpoint and signs in as you:</p>
			<Box text={mcp} />
			<App name="claude.ai, Claude Desktop and Claude mobile">
				Settings → Connectors → <em>Add custom connector</em>, name it <code>gitmind</code> and paste the URL above. It then works on every device you use Claude on.
			</App>
			<App name="ChatGPT">
				Settings → Apps &amp; Connectors → <em>Create</em> (developer mode), paste the URL above and choose OAuth.
			</App>
			<App name="Claude Code">
				<Box text={`claude mcp add --transport http --scope user gitmind ${mcp}`} />
				<p className="mt-2">
					Then run <code>/mcp</code> in Claude Code to sign in.
				</p>
			</App>
			<App name="Codex">
				<Box text={`[mcp_servers.gitmind]\nurl = "${mcp}"`} />
				<p className="mt-2">
					in <code>~/.codex/config.toml</code>, then <code>codex mcp login gitmind</code>.
				</p>
			</App>
			<App name="Local, offline-capable sync on your laptops">
				The <a href="https://github.com/dunkbing/gitmind">gitmind CLI</a> keeps a git clone of your notes on your machine and serves it to local agents, syncing with this server. It also sets up Claude Code and Codex for you:
				<Box text={`curl -fsSL https://gitmind.app/install.sh | sh\n${me.setupCommand}`} />
				<p className="mt-2 text-muted">
					Windows (PowerShell): <code>irm https://gitmind.app/install.ps1 | iex</code>
				</p>
			</App>
		</div>
	);
}
