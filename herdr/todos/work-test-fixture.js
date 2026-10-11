import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkClient } from "./work-client.js";

export async function workFixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-work-api-"));
	const cwd = join(directory, "project");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(cwd, ".pi/work.json"), JSON.stringify({ project: "project" }));
	const items = new Map();
	const keys = new Map();
	const calls = [];
	let nextId = 1;
	const control = { fail: 0, loseCreateResponse: false, conflicts: 0, delay: 0 };
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = raw ? JSON.parse(raw) : undefined;
		const url = new URL(req.url, "http://localhost");
		calls.push({ method: req.method, path: url.pathname, query: url.searchParams, body, key: req.headers["idempotency-key"] });
		const reply = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
		if (control.delay) await new Promise((done) => setTimeout(done, control.delay));
		if (req.headers.authorization !== "Bearer test-token") return reply(401, {});
		if (control.fail) return reply(control.fail, {});
		if (url.pathname === "/api/v1/projects") return reply(200, { projects: [{ slug: "project" }, { slug: "haume-made" }] });
		if (req.method === "GET" && url.pathname === "/api/v1/work") {
			return reply(200, { work_items: [...items.values()].filter((item) => !url.searchParams.has("state") || url.searchParams.get("state").split(",").includes(item.state)) });
		}
		if (req.method === "POST") {
			const key = req.headers["idempotency-key"];
			if (keys.has(key)) {
				const previous = keys.get(key);
				if (JSON.stringify(body) !== previous.body) return reply(409, {});
				return reply(200, { work_item: items.get(previous.id), replayed: true });
			}
			const item = { id: `work_${String(nextId++).padStart(24, "0")}`, ...body, project: body.project ? { slug: body.project } : null, revision: 1, state: "inbox", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
			items.set(item.id, item);
			keys.set(key, { id: item.id, body: JSON.stringify(body) });
			if (control.loseCreateResponse) { control.loseCreateResponse = false; req.socket.destroy(); return; }
			return reply(201, { work_item: item, replayed: false });
		}
		const id = url.pathname.split("/").at(-1);
		const item = items.get(id);
		if (!item) return reply(404, {});
		if (req.method === "PATCH") {
			if (control.conflicts > 0) { control.conflicts--; item.revision++; item.description += "\nConcurrent edit"; return reply(409, {}); }
			if (body.revision !== item.revision) return reply(409, {});
			Object.assign(item, body, { revision: item.revision + 1 });
		}
		return reply(200, { work_item: item });
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const options = { url: `http://127.0.0.1:${server.address().port}`, stateDir: join(directory, "state"), env: { HAUME_WORK_API_TOKEN: "test-token" }, timeout: 500 };
	return { cwd, directory, client: new WorkClient(options), options, items, keys, calls, control, async close() { server.closeAllConnections(); await new Promise((done) => server.close(done)); await rm(directory, { recursive: true, force: true }); } };
}
