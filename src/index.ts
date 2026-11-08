// Moral Algebra Worker
// - Serves the static page from /public (via the ASSETS binding)
// - POST /api/decide asks Jev (TypeSafe's decision model on Workers AI) to weigh the reasons

interface Reason { t: string; w: number }
interface Side { name: string; pros: Reason[]; cons: Reason[] }
type SideKey = 'a' | 'b';
type Kind = 'pros' | 'cons';

const MODEL = 'typesafe/jev';
const MAX_REASONS = 24;
const LEVELS = ['Barely matters', 'Minor factor', 'Moderate factor', 'Major factor', 'Decisive factor'];

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/decide') {
      if (request.method !== 'POST') return text('Method not allowed', 405);
      return decide(request, env);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function decide(request: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return text('Request body must be JSON', 400); }

  const a = cleanSide(body?.a);
  const b = body?.b ? cleanSide(body.b) : null;
  const q = clip(body?.q, 200);
  if (!a?.name) return text('Option A needs a name', 400);
  if (b && !b.name) return text('Option B needs a name', 400);

  const sides: Partial<Record<SideKey, Side>> = b ? { a, b } : { a };
  const factors: { side: SideKey; kind: Kind; t: string }[] = [];
  for (const side of Object.keys(sides) as SideKey[]) {
    for (const kind of ['pros', 'cons'] as Kind[]) {
      for (const r of sides[side]![kind]) factors.push({ side, kind, t: r.t });
    }
  }
  if (factors.length < 2) return text('Add at least two reasons', 400);
  if (factors.length > MAX_REASONS) return text(`Too many reasons (max ${MAX_REASONS})`, 400);

  // What Jev reads: the decision, every option, and the user's own 1–5 weights.
  const state = {
    decision: q || (b ? `${a.name} or ${b.name}?` : `Should I go with ${a.name}?`),
    note: "Each reason carries the user's own importance weight, from 1 (minor) to 5 (major).",
    options: Object.values(sides).map(s => ({
      name: s!.name,
      pros: s!.pros.map(r => ({ reason: r.t, weight: r.w })),
      cons: s!.cons.map(r => ({ reason: r.t, weight: r.w })),
    })),
  };

  // What we ask Jev: how much each reason should really count, given everything.
  // The verdict is then the AI-weighted tally of those scores, so it always
  // agrees with the "Weighed most" list instead of being a separate guess.
  const questions: Record<string, unknown> = {};
  factors.forEach((f, i) => {
    questions[`r${i}`] = {
      type: 'score',
      instructions: `How much should this ${f.kind === 'pros' ? 'pro' : 'con'} of "${sides[f.side]!.name}" count in the final decision: "${f.t}"`,
      criteria: LEVELS,
    };
  });

  let answers: any;
  try {
    const raw = await askJev(env, { state, questions });
    answers = (raw?.answers ?? raw?.result?.answers) as Record<string, any> | undefined;
  } catch (err) {
    return text(`Jev call failed: ${(err as Error).message}`, 502);
  }
  if (!answers) return text('Jev returned no answers', 502);

  const scored = factors.map((f, i) => ({ ...f, score: level(answers[`r${i}`]) }));

  // Reasons that argue for A: A's pros and B's cons. For B: the reverse.
  // With one option, "for" is its pros and "against" is its cons.
  const sum = (pred: (f: typeof scored[number]) => boolean) =>
    scored.filter(pred).reduce((n, f) => n + f.score, 0);
  const forA = sum(f => (f.side === 'a' && f.kind === 'pros') || (f.side === 'b' && f.kind === 'cons'));
  const forB = sum(f => (f.side === 'b' && f.kind === 'pros') || (f.side === 'a' && f.kind === 'cons'));
  const pA = forA + forB > 0 ? forA / (forA + forB) : 0.5;

  if (b) {
    const pick: SideKey = pA >= 0.5 ? 'a' : 'b';
    return json({ single: false, pick, p: pick === 'a' ? pA : 1 - pA, factors: scored });
  }
  return json({ single: true, pick: 'a', p: pA, factors: scored });
}

// With a TypeSafe API key, call Jev directly. Otherwise fall back to Workers AI,
// which bills Jev to AI Gateway credits.
async function askJev(env: Env, input: { state: unknown; questions: unknown }): Promise<any> {
  const key = (env as unknown as { TYPESAFE_API_KEY?: string }).TYPESAFE_API_KEY;
  if (!key) return (env.AI as any).run(MODEL, input);

  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', ...input }),
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Expected level from the score's probabilities, scaled to 0–1.
function level(ans: any): number {
  const probs = ans?.probabilities as Record<string, number> | undefined;
  if (probs && Object.keys(probs).length > 1) {
    const keys = Object.keys(probs);
    const expected = keys.reduce((sum, k) => sum + Number(k) * Number(probs[k]), 0);
    return clamp01(expected / (keys.length - 1));
  }
  const s = Number(ans?.score) || 0;
  return clamp01(s > 1 ? s / (LEVELS.length - 1) : s);
}

function cleanSide(x: any): Side | null {
  if (!x || typeof x !== 'object') return null;
  const items = (arr: unknown): Reason[] =>
    (Array.isArray(arr) ? arr : [])
      .map((i: any) => ({ t: clip(i?.t, 200), w: Math.min(5, Math.max(1, Math.round(Number(i?.w)) || 3)) }))
      .filter(i => i.t);
  return { name: clip(x.name, 80), pros: items(x.pros), cons: items(x.cons) };
}

const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const text = (msg: string, status: number) => new Response(msg, { status, headers: { 'content-type': 'text/plain' } });
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
