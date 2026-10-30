import { createConnection } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";

const ResultSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true) }),
  Type.Object({ ok: Type.Literal(false), error: Type.String({ maxLength: 512 }) }),
]);

/** No shell or terminal input. A timed, single request to the session's private local socket. */
export function sendFooterControl(endpoint, action) {
  return new Promise(resolve => {
    const socket = createConnection(endpoint.socket);
    let input = "";
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(result);
    };
    const unavailable = () => finish({ ok: false, error: "Pi footer controls are unavailable. Reload the Pi session." });
    socket.setTimeout(5000, unavailable);
    socket.setEncoding("utf8");
    socket.on("error", unavailable);
    socket.on("end", unavailable);
    socket.on("connect", () => socket.write(`${JSON.stringify({ owner: endpoint.owner, session: endpoint.session, action })}\n`));
    socket.on("data", chunk => {
      input += chunk;
      if (input.length > 4096) { unavailable(); return; }
      if (!input.includes("\n")) return;
      try {
        const response = JSON.parse(input.trim());
        if (Check(ResultSchema, response)) finish(response);
        else unavailable();
      } catch { unavailable(); }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [socket, owner, session, action] = process.argv.slice(2);
  const result = socket && owner && session && ["model", "thinking", "fast"].includes(action)
    ? await sendFooterControl({ socket, owner, session }, action)
    : { ok: false, error: "Invalid footer control arguments." };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
