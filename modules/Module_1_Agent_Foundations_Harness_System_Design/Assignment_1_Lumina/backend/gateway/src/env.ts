import { config } from 'dotenv';
import { resolve } from 'node:path';

// Both services read the single .env at the assignment root.
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const env = {
  port: num(process.env.PORT_GATEWAY ?? process.env.PORT, 8787),
  agentUrl: process.env.AGENT_URL ?? 'http://localhost:8000',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Phase 5 D19: raised 30 → 120. Ingestion status is POLLED, and both clients poll faster
  // than the old default allowed: bench.mjs:332-339 every 1200ms (~50/min) and
  // web/src/components/SpacesPanel.tsx:42-47 every 1500ms (~40/min). At 30 the poll loop
  // itself 429s, uploadAndWait throws, recall@5 is never measured, and the UI errors
  // mid-ingest. No number in sla.json/SPEC.md/AGENTS.md/TECHNICAL.md declares 30 — it was an
  // undeclared Phase 3 default, re-picked here against now-known load.
  rateLimitPerMinute: num(process.env.RATE_LIMIT_PER_MINUTE, 120),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Serve the built UI from the gateway in production so one host serves / and /evals. */
  webDist: resolve(process.cwd(), '../../web/dist')
} as const;
