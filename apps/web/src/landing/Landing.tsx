import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, useScroll, useMotionValueEvent } from 'motion/react';
import { solveChinesePostman, type OptimizationRecord } from '@sweep/engine';
import { EXAMPLES, getExample, heroCity } from '@sweep/engine/examples';
import { SiteNav } from '../components/SiteNav';
import { BotanicalCursorField } from '../components/botanical/BotanicalCursorField';
import { Icon, type IconName } from '../components/Icon';
import { StaticNetwork } from './StaticNetwork';
import { usePrefs, useReducedMotion } from '../state/prefs';
import { webglAvailable, whenTextSettled } from '../lib/webgl';
import { WebGLBoundary } from '../components/WebGLBoundary';
import { formatDistance, formatMs, formatNumber, formatPercent } from '../lib/format';
import '../styles/landing.css';

const HeroScene = lazy(() => import('../three/HeroScene'));

const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-10% 0px' },
  transition: { duration: 0.8, ease: EASE },
};

function solveOk(id: string): OptimizationRecord | null {
  const ex = getExample(id);
  if (!ex) return null;
  const r = solveChinesePostman(ex.graph);
  return r.ok ? r : null;
}

interface Tool {
  id: 'directions' | 'sweep' | 'workspace' | 'lab';
  to: string;
  icon: IconName;
  name: string;
  where: string;
  text: string;
  examples?: string;
  source: string;
}

/** The four ways in, in the site navigation's order. Each says what it does and who computes the answer. */
const TOOLS: Tool[] = [
  {
    id: 'directions',
    to: '/directions',
    icon: 'route',
    name: 'Directions',
    where: 'Anywhere in the world',
    text: 'Search two places or click the map, then get car, bicycle or walking directions with turn-by-turn instructions and alternatives.',
    source: 'Computed by the public OSRM service on OpenStreetMap data, not by SWEEP. Free-flow times; no live traffic.',
  },
  {
    id: 'sweep',
    to: '/sweep',
    icon: 'truck',
    name: 'Sweep planner',
    where: 'Any real zone, up to 25 km²',
    text: 'Draw a zone over real streets. Inside the bundled Pune extract it plans at once; elsewhere the streets are downloaded live from OpenStreetMap, in polite tiles for large zones. SWEEP then plans routes that cover every street for your vehicles. Play the shift to watch them drive it.',
    examples: 'One-click examples over real Pune areas: around VIT (1 km²), Bibwewadi and VIT (4 km²), Kothrud (4 km²), the old city (9 km²) and the centre (about 20 km²).',
    source: "SWEEP's own coverage engine. Every plan shows its proven lower bound and gap.",
  },
  {
    id: 'workspace',
    to: '/workspace',
    icon: 'cube',
    name: 'Pune algorithm lab',
    where: 'Bibwewadi and VIT, in 3D',
    text: 'Real OpenStreetMap streets and buildings, bundled with the app. Compare five shortest-path algorithms on one trip, plan coverage for a fleet with shift limits, and close a road to see what changes.',
    source: "SWEEP's own engine, on a bundled extract that lists its own gaps.",
  },
  {
    id: 'lab',
    to: '/lab',
    icon: 'sigma',
    name: 'Network lab',
    where: 'The method, step by step',
    text: 'Small networks and the exact Chinese Postman method: the odd intersections, the cheapest pairing, the Euler circuit and the proof that the route is optimal. Build or import your own.',
    source: "SWEEP's own engine, on sample networks or yours.",
  },
];

interface LedgerRow {
  id: string;
  title: string;
  vertices: number;
  odd: number;
  required: number;
  optimal: number;
  greedy: number;
  doubled: number;
  repeated: number;
  ms: number;
  certified: boolean;
}

export default function Landing() {
  const theme = usePrefs((s) => s.theme);
  const setMotion = usePrefs((s) => s.setMotion);
  const reduced = useReducedMotion();
  const heroRef = useRef<HTMLElement>(null);
  const [heroVisible, setHeroVisible] = useState(true);
  const gl = useMemo(() => webglAvailable(), []);
  // The static drawing shows until the page's text has its fonts; only then is the 3D hero's code loaded
  // (see whenTextSettled in lib/webgl.ts).
  const [textSettled, setTextSettled] = useState(false);
  useEffect(() => {
    let live = true;
    void whenTextSettled().then(() => live && setTextSettled(true));
    return () => {
      live = false;
    };
  }, []);
  // A light hero: the static drawing is the hero. The 3D scene (about 1 MB of code, and a WebGL context) is added
  // only on a wide screen with a fine pointer, without data saving or reduced motion, once the browser is idle.
  // Once loaded it stays, and the motion toggle only pauses it.
  const roomy = useMemo(() => {
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    return !saveData && typeof matchMedia === 'function' && matchMedia('(min-width: 900px) and (pointer: fine)').matches;
  }, []);
  const [scene3d, setScene3d] = useState(false);
  useEffect(() => {
    if (scene3d || !gl || !roomy || reduced || !textSettled) return;
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(() => setScene3d(true), { timeout: 1500 });
    return () => cancel(id);
  }, [scene3d, gl, roomy, reduced, textSettled]);

  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setHeroVisible(!!e?.isIntersecting), { threshold: 0.02 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // ---- live engine facts: computed in this browser, never hard-coded ----
  const hero = useMemo(() => {
    const g = heroCity();
    const t = performance.now();
    const r = solveChinesePostman(g);
    return { graph: g, record: r.ok ? r : null, ms: performance.now() - t };
  }, []);
  const oldTown = useMemo(() => ({ graph: getExample('old-town-grid')!.graph, record: solveOk('old-town-grid') }), []);
  const konigsberg = useMemo(() => ({ graph: getExample('konigsberg')!.graph, record: solveOk('konigsberg') }), []);
  const meridian = useMemo(() => ({ graph: getExample('meridian-district')!.graph, record: solveOk('meridian-district') }), []);
  const ledger = useMemo<LedgerRow[]>(
    () =>
      EXAMPLES.filter((e) => e.id !== 'twin-districts')
        .map((ex) => {
          const t = performance.now();
          const r = solveChinesePostman(ex.graph);
          const ms = performance.now() - t;
          if (!r.ok) return null;
          return {
            id: ex.id,
            title: ex.title,
            vertices: r.input.vertexCount,
            odd: r.oddVertexIds.length,
            required: r.route.requiredDistance,
            optimal: r.route.totalDistance,
            greedy: r.baselines.find((b) => b.id === 'greedy-pairing')!.total!,
            doubled: r.baselines.find((b) => b.id === 'double-every-street')!.total!,
            repeated: r.route.repeatedDistance,
            ms,
            certified: r.algorithm.optimal,
          };
        })
        .filter((x): x is LedgerRow => x !== null),
    [],
  );

  // ---- sticky story progress ----
  const storyRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: storyRef, offset: ['start start', 'end end'] });
  const [stage, setStage] = useState(0);
  useMotionValueEvent(scrollYProgress, 'change', (v) => setStage(Math.min(4, Math.max(0, Math.floor(v * 5.2)))));
  const STAGE_TO_STEP = [0, 1, 3, 4, 6];

  const ot = oldTown.record;
  const hr = hero.record;
  const kb = konigsberg.record;
  const doubled = ot?.baselines.find((b) => b.id === 'double-every-street')?.total ?? 0;

  const STORY = ot
    ? [
        { t: 'The network', d: `${ot.input.vertexCount} intersections and ${ot.input.edgeCount} streets: ${formatDistance(ot.route.requiredDistance)} that must all be serviced.` },
        { t: 'The odd ones out', d: `${ot.oddVertexIds.length} intersections have an odd number of streets. A closed route enters and leaves in pairs, so every odd intersection forces a repeat.` },
        { t: 'Pair them, exactly', d: `Edmonds' blossom algorithm pairs the odd intersections with the least total detour: ${formatDistance(ot.matching.cost)}, certified optimal.` },
        { t: 'Make it Eulerian', d: `Duplicating the ${ot.matching.pairs.length} matched shortest paths makes every degree even. Repeated distance: ${formatDistance(ot.route.repeatedDistance)}.` },
        { t: 'One closed route', d: `Hierholzer's algorithm walks it in ${ot.route.steps.length} steps: ${formatDistance(ot.route.totalDistance)}, against ${formatDistance(doubled)} for out-and-back on every street.` },
      ]
    : [];

  return (
    <div className="landing">
      <BotanicalCursorField />
      <SiteNav overlay />

      {/* ------------------------------------------------------------ hero */}
      <section className="hero" ref={heroRef} data-bloom-zone aria-labelledby="hero-title">
        <div className="hero__scene" aria-hidden="true">
          {scene3d ? (
            <WebGLBoundary fallback={null}>
            <Suspense fallback={null}>
              <HeroScene theme={theme} paused={!heroVisible} reduced={reduced} />
            </Suspense>
            </WebGLBoundary>
          ) : (
            <div className="hero-fallback">
              <StaticNetwork graph={hero.graph} result={hero.record} overlay="route" label="" />
            </div>
          )}
        </div>
        <div className="hero__veil" />
        <div className="hero__content">
          <motion.div className="hero__copy" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1, ease: EASE }}>
            <p className="eyebrow">Street coverage and routing · real OpenStreetMap streets</p>
            <h1 id="hero-title" className="hero__title">
              Every street.
              <br />
              One <span className="serif">intelligent</span> <span className="spectral-text">route.</span>
            </h1>
            <p className="hero__lede">
              SWEEP plans routes that drive every street of a zone, for one vehicle or a fleet, and shows how close each plan is to the best possible. Draw a zone over real streets anywhere, or explore Pune in 3D.
            </p>
            <div className="hero__actions">
              <Link to="/sweep" className="btn btn--primary btn--lg btn--spectral" data-testid="cta-sweep">
                Plan a sweep <Icon name="next" size={16} />
              </Link>
              <Link to="/workspace" className="btn btn--quiet btn--lg" data-testid="cta-workspace">
                Open the Pune lab
              </Link>
              <Link to="/mathematics" className="btn btn--ghost btn--lg">
                Explore the mathematics
              </Link>
            </div>
          </motion.div>
          <div className="hero__foot">
            {hr && (
              <dl className="instrument" aria-label="Live computation for the district shown" data-testid="hero-instrument">
                <div className="instrument__cell">
                  <dt className="instrument__k">District</dt>
                  <dd className="instrument__v">{formatNumber(hr.input.vertexCount)} intersections</dd>
                </div>
                <div className="instrument__cell">
                  <dt className="instrument__k">Odd</dt>
                  <dd className="instrument__v">{formatNumber(hr.oddVertexIds.length)}</dd>
                </div>
                <div className="instrument__cell">
                  <dt className="instrument__k">Route</dt>
                  <dd className="instrument__v">{formatDistance(hr.route.totalDistance)}</dd>
                </div>
                <div className="instrument__cell">
                  <dt className="instrument__k">Repeated</dt>
                  <dd className="instrument__v">{formatDistance(hr.route.repeatedDistance)}</dd>
                </div>
                <div className="instrument__cell">
                  <dt className="instrument__k">Status</dt>
                  <dd className={`instrument__v${hr.algorithm.optimal ? ' instrument__v--ok' : ''}`}>{hr.algorithm.optimal ? 'optimal ✓' : 'unverified'}</dd>
                </div>
                <div className="instrument__cell">
                  <dt className="instrument__k">Solved here in</dt>
                  <dd className="instrument__v">{formatMs(hero.ms)}</dd>
                </div>
              </dl>
            )}
            <p className="hero__note small" data-testid="hero-note">
              The district drawn here is a synthetic illustration, solved live in your browser. The Sweep planner and the Pune lab work on real OpenStreetMap streets.
            </p>
            <div className="btn-row">
              <button type="button" className="btn btn--ghost btn--sm motion-toggle" onClick={() => setMotion(reduced ? 'full' : 'reduced')} aria-pressed={reduced} data-testid="motion-toggle">
                {reduced ? 'Resume motion' : 'Pause motion'}
              </button>
              <span className="hero__scroll" aria-hidden="true">
                Scroll
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ four tools */}
      <section className="section paths" id="tools" aria-labelledby="tools-title">
        <div className="section__label">
          <span className="eyebrow">Start here</span>
        </div>
        <h2 id="tools-title" className="section__title">
          Four tools, <span className="serif">one honest map.</span>
        </h2>
        <p className="section__lede" data-testid="tools-honesty">
          Directions are computed by the public OSRM service. SWEEP's own algorithms run in the Sweep planner, the Pune lab and the Network lab, and each result there is either proven optimal or shown with a proven bound.
        </p>
        <ul className="paths__grid">
          {TOOLS.map((t) => (
            <li key={t.id} className="path" data-testid={`tool-${t.id}`}>
              <span className="path__icon" aria-hidden="true">
                <Icon name={t.icon} size={22} />
              </span>
              <h3 className="path__name">
                <Link to={t.to} className="path__link" data-testid={`tool-link-${t.id}`}>
                  {t.name}
                </Link>
              </h3>
              <p className="path__where">{t.where}</p>
              <p className="path__text">{t.text}</p>
              {t.examples && <p className="path__text">{t.examples}</p>}
              <p className="path__source">{t.source}</p>
              <span className="path__go" aria-hidden="true">
                Open <Icon name="next" size={14} />
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------------------------------------------------- A · problem */}
      <section className="section" aria-labelledby="a-title">
        <motion.div {...reveal}>
          <div className="section__label">
            <span className="num mono">A</span>
            <span className="eyebrow">The problem</span>
          </div>
          <h2 id="a-title" className="section__title">
            A sweeper must pass every street. <span className="serif">Most routes repeat themselves.</span>
          </h2>
          <p className="section__lede">
            Street cleaning, inspection and maintenance crews must cover every segment of a district and return to the depot. Some backtracking is mathematically unavoidable, but how much is not. SWEEP finds the minimum and shows exactly which streets must be driven twice, and why.
          </p>
        </motion.div>
        {ot && (
          <div className="plates">
            <motion.figure className="plate plate--naive" {...reveal}>
              <div className="plate__frame">
                <StaticNetwork graph={oldTown.graph} label="Old Town Grid: every street driven out and back" />
              </div>
              <figcaption className="plate__caption">
                <span className="muted">Out-and-back on every street</span>
                <span className="plate__figure plate__figure--bad">{formatDistance(doubled)}</span>
              </figcaption>
            </motion.figure>
            <motion.figure className="plate" {...reveal} transition={{ ...reveal.transition, delay: 0.12 }}>
              <div className="plate__frame">
                <StaticNetwork graph={oldTown.graph} result={ot} overlay="route" label="Old Town Grid with SWEEP's optimal route" />
              </div>
              <figcaption className="plate__caption">
                <span className="muted">SWEEP optimal route · {ot.route.repeatedRequiredTraversals} streets repeated</span>
                <span className="plate__figure plate__figure--good">{formatDistance(ot.route.totalDistance)}</span>
              </figcaption>
            </motion.figure>
          </div>
        )}
      </section>

      {/* ---------------------------------------------- B · transformation */}
      {ot && (
        <section className="story section--rule" ref={storyRef} aria-labelledby="b-title">
          <div className="story__sticky">
            <div>
              <div className="section__label">
                <span className="num mono">B</span>
                <span className="eyebrow">The transformation</span>
              </div>
              <h2 id="b-title" className="section__title">
                From tangle to <span className="serif">tour</span>.
              </h2>
              <ol className="story__steps">
                {STORY.map((s, i) => (
                  <li key={s.t} className={`story__step${i === stage ? ' is-active' : ''}`}>
                    <span className="num mono">0{i + 1}</span>
                    <div>
                      <h3>{s.t}</h3>
                      <p>{s.d}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <div className="story__visual">
              <StaticNetwork graph={oldTown.graph} result={ot} overlay="explain" explainStep={STAGE_TO_STEP[stage]!} showWeights label={`Old Town Grid, stage ${stage + 1} of 5: ${STORY[stage]?.t ?? ''}`} dimBase={stage >= 3} />
              <div className="story__meter" aria-live="polite">
                <span>
                  odd <b>{stage >= 1 ? ot.oddVertexIds.length : '—'}</b>
                </span>
                <span>
                  added <b>{stage >= 3 ? formatDistance(ot.augmentation.addedDistance) : '—'}</b>
                </span>
                <span>
                  route <b>{stage >= 4 ? formatDistance(ot.route.totalDistance) : '—'}</b>
                </span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------ C · insight */}
      <section className="section section--rule" aria-labelledby="c-title">
        <motion.div {...reveal} className="split">
          <div>
            <div className="section__label">
              <span className="num mono">C</span>
              <span className="eyebrow">The mathematical insight</span>
            </div>
            <h2 id="c-title" className="section__title">
              Euler saw it in 1736. <span className="serif">We compute it in milliseconds.</span>
            </h2>
            <p className="section__lede">
              In Königsberg all four landmasses have an odd number of bridges, so no walk can cross each bridge exactly once. {kb ? `The cheapest closed walk repeats ${kb.route.repeatedRequiredTraversals} bridges.` : ''}
            </p>
          </div>
          {kb && (
            <div className="invite__plate">
              <StaticNetwork graph={konigsberg.graph} result={kb} overlay="explain" explainStep={1} showLabels label="Königsberg's four landmasses, each of odd degree" />
            </div>
          )}
        </motion.div>
        <div className="theorems">
          {[
            { n: 'i', h: 'Degree parity', p: 'A closed walk leaves every intersection as often as it arrives, so it uses an even number of street-ends there.', f: 'Euler circuit ⇔ connected ∧ every deg(v) even', c: 'Euler, 1736 · Hierholzer, 1873' },
            { n: 'ii', h: 'Odd vertices pair up', p: 'Every street has two ends, so the degrees sum to twice the street count. The number of odd intersections is always even.', f: 'Σ deg(v) = 2 · |E|', c: 'Handshake lemma' },
            { n: 'iii', h: 'Cheapest pairing', p: 'Pair the odd intersections so the total shortest-path distance is minimal: a minimum-weight perfect matching.', f: 'min Σ d(a, b) over perfect matchings of T', c: 'Edmonds, 1965 · Edmonds & Johnson, 1973' },
            { n: 'iv', h: 'One walk covers all', p: 'Duplicating the matched paths makes every degree even. The augmented network has an Euler circuit, and that circuit is the optimal route.', f: 'cost = w(E_req) + w(min T-join)', c: 'Chinese Postman Problem · Guan, 1960' },
          ].map((t, i) => (
            <motion.div key={t.n} className="theorem" {...reveal} transition={{ ...reveal.transition, delay: i * 0.08 }}>
              <span className="theorem__n">{t.n}</span>
              <h3>{t.h}</h3>
              <p>{t.p}</p>
              <div className="formula">{t.f}</div>
              <cite>{t.c}</cite>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------ D · outcome */}
      <section className="section section--rule" aria-labelledby="d-title">
        <motion.div {...reveal}>
          <div className="section__label">
            <span className="num mono">D</span>
            <span className="eyebrow">The outcome</span>
          </div>
          <h2 id="d-title" className="section__title">
            Measured, <span className="serif">not promised.</span>
          </h2>
          <p className="section__lede">Every figure below was computed a moment ago in your browser by the same engine the network lab uses, on its sample networks. No savings are estimated and nothing is hard-coded.</p>
        </motion.div>
        <div className="ledger" data-testid="ledger">
          <table className="table">
            <caption>Greedy pairing and out-and-back are real, valid alternative routes, computed for comparison. Times are measured on this device.</caption>
            <thead>
              <tr>
                <th scope="col">Network</th>
                <th scope="col" className="num">
                  Intersections
                </th>
                <th scope="col" className="num">
                  Odd
                </th>
                <th scope="col" className="num">
                  Required
                </th>
                <th scope="col" className="num">
                  SWEEP optimal
                </th>
                <th scope="col" className="num">
                  Greedy pairing
                </th>
                <th scope="col" className="num">
                  Out-and-back
                </th>
                <th scope="col" className="num">
                  Repeated
                </th>
                <th scope="col" className="num">
                  Solve time
                </th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((r) => (
                <tr key={r.id}>
                  <th scope="row">
                    <Link to={`/lab?example=${r.id}`}>{r.title}</Link>
                  </th>
                  <td className="num">{formatNumber(r.vertices)}</td>
                  <td className="num">{formatNumber(r.odd)}</td>
                  <td className="num">{formatDistance(r.required)}</td>
                  <td className="num good">
                    {formatDistance(r.optimal)} {r.certified ? '✓' : ''}
                  </td>
                  <td className="num">{formatDistance(r.greedy)}</td>
                  <td className="num bad">{formatDistance(r.doubled)}</td>
                  <td className="num">{formatPercent(r.optimal > 0 ? r.repeated / r.optimal : 0)}</td>
                  <td className="num">{formatMs(r.ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ----------------------------------------------------- E · workspace */}
      <section className="section section--rule" aria-labelledby="e-title">
        <div className="split">
          <motion.div {...reveal}>
            <div className="section__label">
              <span className="num mono">E</span>
              <span className="eyebrow">The network lab</span>
            </div>
            <h2 id="e-title" className="section__title">
              Draw a district. <span className="serif">Watch it solve itself.</span>
            </h2>
            <ul className="invite__list">
              <li>
                <Icon name="connect" /> Build or import a network: intersections, streets, their lengths, and which streets need service.
              </li>
              <li>
                <Icon name="route" /> Optimise with the exact Chinese Postman algorithm. Every result is independently verified.
              </li>
              <li>
                <Icon name="layers" /> Step through the proof: degrees, shortest paths, matching, augmentation and the Euler circuit.
              </li>
              <li>
                <Icon name="cube" /> Fly the route in 3D, then export JSON, CSV or a printable report.
              </li>
            </ul>
            <Link to="/lab" className="btn btn--primary btn--lg">
              Open the network lab <Icon name="next" size={16} />
            </Link>
          </motion.div>
          {meridian.record && (
            <motion.div className="invite__plate" {...reveal} transition={{ ...reveal.transition, delay: 0.1 }}>
              <StaticNetwork graph={meridian.graph} result={meridian.record} overlay="route" assumedWidth={720} label={`Meridian District, a synthetic network of ${meridian.record.input.vertexCount} intersections, with its optimal route`} />
              <p className="faint small" style={{ marginTop: 10 }}>
                Meridian District (synthetic): {formatNumber(meridian.record.input.vertexCount)} intersections, {formatNumber(meridian.record.oddVertexIds.length)} odd, and a {formatDistance(meridian.record.route.totalDistance)} optimal route.
              </p>
            </motion.div>
          )}
        </div>
      </section>

      {/* --------------------------------------------------- F · credibility */}
      <section className="section section--rule" id="credibility" aria-labelledby="f-title">
        <motion.div {...reveal}>
          <div className="section__label">
            <span className="num mono">F</span>
            <span className="eyebrow">Method · validation · limits</span>
          </div>
          <h2 id="f-title" className="section__title">
            Every route <span className="serif">carries its proof.</span>
          </h2>
        </motion.div>
        <div className="cred">
          <div>
            <h3>Algorithm</h3>
            <ul>
              <li>Two-way streets: find the odd intersections, pair them at least cost with Edmonds' blossom algorithm, duplicate the paired shortest paths and walk the Euler circuit with Hierholzer's algorithm.</li>
              <li>One-way streets: an exact minimum-cost flow decides which streets to drive again.</li>
              <li>Large zones that ignore one-way streets: a heuristic, reported with a proven lower bound and the gap, never as optimal.</li>
              <li>Several vehicles: the fleet planner splits the work under shift limits and states lower bounds on distance and on when the last vehicle is back.</li>
              <li>Point to point: Dijkstra, A*, bidirectional Dijkstra, ALT and contraction hierarchies answer the same query, and must agree.</li>
            </ul>
          </div>
          <div>
            <h3>Validation</h3>
            <ul>
              <li>An independent verifier re-checks every result for continuity, closure, coverage, distances and parity.</li>
              <li>An LP-duality certificate proves each matching optimal, and small cases are cross-checked by exhaustive subset DP.</li>
              <li>The test suite compares results with brute-force search on random multigraphs, and with networkx in Python.</li>
              <li>The browser tests check that the numbers on screen equal an engine run on the same input.</li>
            </ul>
          </div>
          <div>
            <h3>Limitations</h3>
            <ul>
              <li>Directions come from public OSRM servers, not from SWEEP. Their times assume free-flowing traffic.</li>
              <li>Outside the bundled Pune extract, the Sweep planner downloads streets live from OpenStreetMap, up to 25 km² per zone. A busy server makes that slow, and it can fail.</li>
              <li>The Pune lab's bundled extract is partial: some tile downloads failed, and its provenance dialog lists them. Most building heights are estimates, marked as such.</li>
              <li>In the network lab, the required streets must be connected. When they are not, it explains why that case is NP-hard and suggests connecting streets.</li>
              <li>In the network lab, exact matching is supported up to 600 odd intersections. Its sample districts are synthetic teaching networks, labelled as such; real networks can be imported as GeoJSON.</li>
            </ul>
          </div>
        </div>
        <p style={{ marginTop: 'var(--space-6)' }}>
          <Link to="/mathematics">Read the full mathematical specification →</Link>
        </p>
      </section>

      <section className="closing section--rule" data-bloom-zone>
        <h2>
          Cover every street.
          <br />
          <span className="serif">Repeat as little as possible.</span>
        </h2>
        <div className="hero__actions closing__actions">
          <Link to="/sweep" className="btn btn--primary btn--lg btn--spectral">
            Plan a sweep <Icon name="next" size={16} />
          </Link>
          <Link to="/workspace" className="btn btn--quiet btn--lg">
            Open the Pune lab
          </Link>
        </div>
        <span className="faint small">Click any empty space here or in the hero to make a blossom unfold.</span>
      </section>

      <footer className="site-footer">
        <span>SWEEP · route intelligence built on graph theory</span>
        <nav aria-label="Footer">
          <Link to="/directions">Directions</Link>
          <Link to="/sweep">Sweep planner</Link>
          <Link to="/workspace">Pune lab</Link>
          <Link to="/lab">Network lab</Link>
          <Link to="/mathematics">Mathematics</Link>
          <Link to="/account">Account</Link>
        </nav>
      </footer>
    </div>
  );
}
