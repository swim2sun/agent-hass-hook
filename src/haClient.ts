import { request as httpRequest } from "node:http";
import { request as httpsRequest, RequestOptions } from "node:https";

export interface HAResult {
  ok: boolean;
  error?: "timeout" | "connection_error" | "http_4xx" | "http_5xx";
  status?: number;
  durationMs?: number;
}

export interface CallTimeouts { connectMs: number; readMs: number; verifySsl?: boolean; }

export function callService(
  url: string,
  token: string,
  service: string,
  data: Record<string, unknown>,
  t: CallTimeouts,
): Promise<HAResult> {
  if (!service.includes(".")) {
    return Promise.reject(new Error(`service must be "domain.service", got ${JSON.stringify(service)}`));
  }
  const [domain, svc] = service.split(/\.(.*)/s) as [string, string];

  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Promise.reject(new Error(`unsupported URL scheme: ${url}`));
  }
  const isHttps = parsed.protocol === "https:";
  const prefix = parsed.pathname.replace(/\/+$/, "");
  const path = `${prefix}/api/services/${domain}/${svc}`;
  const body = Buffer.from(JSON.stringify(data), "utf-8");

  const options: RequestOptions = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
    },
    ...(isHttps && t.verifySsl === false ? { rejectUnauthorized: false } : {}),
  };

  return new Promise<HAResult>((resolve) => {
    const start = process.hrtime.bigint();
    const elapsedMs = () => Number(process.hrtime.bigint() - start) / 1e6;
    let settled = false;
    const done = (r: HAResult) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      resolve({ ...r, durationMs: Math.round(elapsedMs()) });
    };

    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(options, (res) => {
      // switch to the read timeout once connected
      req.setTimeout(t.readMs, () => done({ ok: false, error: "timeout" }));
      res.on("data", () => { /* drain */ });
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) return done({ ok: true, status });
        return done({ ok: false, error: status >= 400 && status < 500 ? "http_4xx" : "http_5xx", status });
      });
    });

    // connect timeout: applies until the socket connects
    req.setTimeout(t.connectMs, () => done({ ok: false, error: "timeout" }));
    req.on("socket", (socket) => {
      socket.on("connect", () => req.setTimeout(t.readMs, () => done({ ok: false, error: "timeout" })));
    });
    req.on("error", () => done({ ok: false, error: "connection_error" }));
    req.write(body);
    req.end();
  });
}
