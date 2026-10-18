// The link graph: notes and the [[links]] between them, laid out by a small
// force simulation on a canvas. Click a note to open it, drag to rearrange,
// scroll to zoom.

import { useEffect, useRef, useState } from "react";
import { type Workspace, api } from "../api";
import { navigate, noteUrl } from "../router";

export function GraphView({ ws }: { ws: Workspace }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const [count, setCount] = useState<number | null>(null);

	useEffect(() => {
		let stop = false;
		const cv = canvas.current!;
		const ctx = cv.getContext("2d")!;
		api.graph(ws.slug).then((data) => {
			if (stop) return;
			setCount(data.nodes.length);
			const css = getComputedStyle(document.documentElement);
			const color = (v: string) => css.getPropertyValue(v).trim();
			type N = (typeof data.nodes)[0] & { x: number; y: number; vx: number; vy: number };
			const nodes: N[] = data.nodes.map((n, i) => {
				const a = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
				return { ...n, x: Math.cos(a) * 120, y: Math.sin(a) * 120, vx: 0, vy: 0 };
			});
			const byPath = new Map(nodes.map((n) => [n.path, n]));
			const edges = data.edges.map((e) => [byPath.get(e.from), byPath.get(e.to)] as const).filter((e): e is readonly [N, N] => !!e[0] && !!e[1]);
			const degree = new Map<N, number>();
			for (const [a, b] of edges) {
				degree.set(a, (degree.get(a) ?? 0) + 1);
				degree.set(b, (degree.get(b) ?? 0) + 1);
			}
			const linked = (n: N) => new Set(edges.flatMap(([a, b]) => (a === n ? [b] : b === n ? [a] : [])));
			let scale = 1;
			let fit = 1;
			let drag: N | null = null;
			let hover: N | null = null;
			let moved = false;
			let energy = 1;
			const dpr = () => devicePixelRatio;
			const resize = () => {
				const w = Math.round(cv.clientWidth * dpr());
				const h = Math.round(cv.clientHeight * dpr());
				if (cv.width !== w || cv.height !== h) {
					cv.width = w;
					cv.height = h;
				}
			};
			const step = () => {
				for (const a of nodes)
					for (const b of nodes) {
						if (a === b) continue;
						const dx = a.x - b.x;
						const dy = a.y - b.y;
						const f = 900 / (dx * dx + dy * dy + 0.01);
						a.vx += dx * f;
						a.vy += dy * f;
					}
				for (const [a, b] of edges) {
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
					const f = (d - 90) * 0.0005;
					a.vx += dx * f;
					a.vy += dy * f;
					b.vx -= dx * f;
					b.vy -= dy * f;
				}
				energy = 0;
				for (const n of nodes) {
					n.vx -= n.x * 0.01;
					n.vy -= n.y * 0.01;
					if (n !== drag) {
						n.x += n.vx * 0.5;
						n.y += n.vy * 0.5;
					}
					energy += Math.abs(n.vx) + Math.abs(n.vy);
					n.vx *= 0.6;
					n.vy *= 0.6;
				}
				if (nodes.length && !drag) {
					let cx = 0;
					let cy = 0;
					for (const n of nodes) {
						cx += n.x;
						cy += n.y;
					}
					cx /= nodes.length;
					cy /= nodes.length;
					for (const n of nodes) {
						n.x -= cx;
						n.y -= cy;
					}
				}
			};
			const fitView = () => {
				let mx = 1;
				let my = 1;
				for (const n of nodes) {
					mx = Math.max(mx, Math.abs(n.x));
					my = Math.max(my, Math.abs(n.y));
				}
				fit = Math.min(1.6, (cv.width / dpr() / 2 - 70) / mx, (cv.height / dpr() / 2 - 40) / my);
			};
			const toScreen = (n: N) => [cv.width / 2 + n.x * scale * fit * dpr(), cv.height / 2 + n.y * scale * fit * dpr()];
			const draw = () => {
				ctx.clearRect(0, 0, cv.width, cv.height);
				const near = hover ? linked(hover) : null;
				ctx.lineWidth = dpr();
				for (const [a, b] of edges) {
					const [x1, y1] = toScreen(a);
					const [x2, y2] = toScreen(b);
					ctx.strokeStyle = hover && (a === hover || b === hover) ? color("--accent") : color("--line");
					ctx.beginPath();
					ctx.moveTo(x1, y1);
					ctx.lineTo(x2, y2);
					ctx.stroke();
				}
				ctx.font = `${12 * dpr()}px ${color("--font-sans") || "system-ui"}`;
				ctx.textAlign = "center";
				for (const n of nodes) {
					const [x, y] = toScreen(n);
					const r = (4 + Math.min(8, (degree.get(n) ?? 0) * 1.5)) * dpr();
					const dim = near && n !== hover && !near.has(n);
					ctx.globalAlpha = dim ? 0.25 : 1;
					ctx.fillStyle = n.pinned ? "#d4932a" : color("--accent");
					ctx.beginPath();
					ctx.arc(x, y, r, 0, 7);
					ctx.fill();
					if (n === hover || near?.has(n) || (degree.get(n) ?? 0) > 2 || nodes.length < 40) {
						ctx.fillStyle = color("--ink");
						ctx.fillText(n.title, x, y - r - 4 * dpr());
					}
				}
				ctx.globalAlpha = 1;
			};
			const pick = (e: PointerEvent) => {
				const r = cv.getBoundingClientRect();
				const px = (e.clientX - r.left) * dpr();
				const py = (e.clientY - r.top) * dpr();
				let best: N | null = null;
				let bd = 400 * dpr();
				for (const n of nodes) {
					const [x, y] = toScreen(n);
					const d = (x - px) ** 2 + (y - py) ** 2;
					if (d < bd) {
						bd = d;
						best = n;
					}
				}
				return best;
			};
			cv.onpointerdown = (e) => {
				drag = pick(e);
				moved = false;
				cv.setPointerCapture(e.pointerId);
			};
			cv.onpointermove = (e) => {
				if (drag) {
					moved = true;
					drag.x += e.movementX / (scale * fit);
					drag.y += e.movementY / (scale * fit);
				} else {
					hover = pick(e);
					cv.style.cursor = hover ? "pointer" : "default";
				}
			};
			cv.onpointerup = () => {
				if (drag && !moved) navigate(noteUrl(ws.slug, drag.path));
				drag = null;
			};
			cv.onwheel = (e) => {
				e.preventDefault();
				scale *= e.deltaY < 0 ? 1.1 : 0.9;
			};
			let ticks = 0;
			const loop = () => {
				if (stop) return;
				resize();
				// Settle, then only redraw (the layout stops moving).
				if (ticks++ < 600 || energy > 0.5 || drag) step();
				if (!drag) fitView();
				draw();
				requestAnimationFrame(loop);
			};
			loop();
		});
		return () => {
			stop = true;
		};
	}, [ws.slug]);

	return (
		<div className="flex h-full flex-col px-5 py-6 md:px-8">
			<div className="flex items-baseline justify-between">
				<h1 className="view-title">Graph</h1>
				<span className="text-[13px] text-muted">{count === null ? "Loading…" : `${count} notes · click to open, drag to move, scroll to zoom`}</span>
			</div>
			<div className="card mt-4 min-h-[420px] flex-1 overflow-hidden">
				<canvas ref={canvas} className="block h-full w-full touch-none" />
			</div>
		</div>
	);
}
