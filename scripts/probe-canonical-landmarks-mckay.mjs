/**
 * End-to-end probe: run the improved canonical-landmarks resolver against the
 * SAME 15 canon landmarks that the real McKay run picked, using the real arxiv +
 * Crossref APIs. Reports arxiv-hit rate before/after the fix so we can show
 * subfish the actual improvement, not just unit-test pass counts.
 *
 * We mock the LLM to return the exact 15 landmarks the McKay run produced
 * (extracted from wiki/bibliography.md), then let the real resolver do its work.
 */
import { searchCanonicalLandmarks } from "../dist/core/agents/init-project/prior-art/canonical-landmarks-search.js";
import { searchArxiv } from "../dist/core/agents/init-project/crawlers.js";

// The 15 canon landmarks the McKay run picked (reverse-engineered from
// mckay-correspondence project's bibliography.md). Not every single one from
// bibliography.md — only the "canon landmarks" section stage 1 picked out.
const MCKAY_15 = [
  { title: "Graphs, singularities, and finite groups", titleEn: "Graphs, singularities, and finite groups",
    authors: ["John McKay"], year: 1980, venue: "Proc. Symp. Pure Math. 37", why: "founding" },
  { title: "Lectures on the Icosahedron", titleEn: "Lectures on the Icosahedron and the Solution of Equations of the Fifth Degree",
    authors: ["Felix Klein"], year: 1884, venue: "Teubner", why: "classical binary polyhedral background" },
  { title: "On isolated rational singularities of surfaces", titleEn: "On isolated rational singularities of surfaces",
    authors: ["Michael Artin"], year: 1966, venue: "Amer. J. Math.", why: "foundational resolution-theoretic language" },
  { title: "Rationale Singularitäten komplexer Flächen", titleEn: "Rational singularities of complex surfaces",
    authors: ["Egbert Brieskorn"], year: 1968, venue: "Invent. Math.", why: "connects rational double points with Lie-theoretic ADE" },
  { title: "Simple Singularities and Simple Algebraic Groups", titleEn: "Simple Singularities and Simple Algebraic Groups",
    authors: ["Peter Slodowy"], year: 1980, venue: "SLN 815", why: "detailed reference for ADE/Lie" },
  { title: "Young person's guide to canonical singularities", titleEn: "Young person's guide to canonical singularities",
    authors: ["Miles Reid"], year: 1987, venue: "Proc. Symp. Pure Math. 46", why: "canonical/terminal singularities & discrepancies" },
  { title: "McKay correspondence", titleEn: "McKay correspondence",
    authors: ["Miles Reid"], year: 1996, venue: "Kinosaki preprint", why: "expository account" },
  { title: "Construction géométrique de la correspondance de McKay", titleEn: "Geometric construction of the McKay correspondence",
    authors: ["Gerardo Gonzalez-Sprinberg", "Jean-Louis Verdier"], year: 1983, venue: "Ann. Sci. ENS", why: "geometric surface McKay" },
  { title: "Hilbert schemes and simple singularities", titleEn: "Hilbert schemes and simple singularities",
    authors: ["Yukari Ito", "Iku Nakamura"], year: 1999, venue: "LMS Lecture Notes 264", why: "G-Hilb bridge" },
  { title: "The McKay correspondence for finite subgroups of SL(3,C)", titleEn: "The McKay correspondence for finite subgroups of SL(3,C)",
    authors: ["Yukari Ito", "Miles Reid"], year: 1996, venue: "Trento proceedings", why: "3d geometric McKay" },
  { title: "The McKay correspondence as an equivalence of derived categories", titleEn: "The McKay correspondence as an equivalence of derived categories",
    authors: ["Tom Bridgeland", "Alastair King", "Miles Reid"], year: 2001, venue: "J. Amer. Math. Soc.", why: "derived McKay" },
  { title: "Hilbert schemes, polygraphs and the Macdonald positivity conjecture", titleEn: "Hilbert schemes, polygraphs and the Macdonald positivity conjecture",
    authors: ["Mark Haiman"], year: 2001, venue: "J. Amer. Math. Soc.", why: "Hilbert scheme background" },
  { title: "La correspondance de McKay", titleEn: "The McKay correspondence",
    authors: ["Miles Reid"], year: 1999, venue: "Séminaire Bourbaki, Astérisque 276", why: "higher-dim survey" },
  { title: "Non-commutative crepant resolutions", titleEn: "Non-commutative crepant resolutions",
    authors: ["Michel Van den Bergh"], year: 2004, venue: "Legacy of Abel", why: "NCCR" },
  { title: "A new cohomology theory of orbifold", titleEn: "A new cohomology theory of orbifold",
    authors: ["Weimin Chen", "Yongbin Ruan"], year: 2004, venue: "Comm. Math. Phys.", why: "Chen–Ruan orbifold cohomology" },
];

async function main() {
  console.log(`Probing ${MCKAY_15.length} canon landmarks with the improved resolver…\n`);
  const startedAt = Date.now();

  // Mock the LLM to return exactly our 15 landmarks (skip the LLM proposal step).
  const llm = async () => JSON.stringify(MCKAY_15);

  const logs = [];
  const hits = await searchCanonicalLandmarks(
    { title: "McKay correspondence", tags: ["math.AG"] },
    {
      llm,
      // Use the real arxiv search wrapper via crawlers.ts.
      searchArxivByTitle: (q, n) => searchArxiv(q, n),
      // Use the default Crossref client (real network).
      searchCrossref: undefined,
      rateDelayMs: 3500, // arxiv rate limit is 1 req/3s — be polite
      emitLog: (m) => { logs.push(m); console.log(`  [log] ${m}`); },
    },
    { maxProposed: 15, crossrefRateMs: 500 },
  );

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n─────────────────────────────────────────────────────`);
  console.log(`Finished in ${elapsed}s`);

  const arxivOnly = hits.filter((h) => h.arxivId && !h.doi).length;
  const arxivPlusDoi = hits.filter((h) => h.arxivId && h.doi).length;
  const doiOnly = hits.filter((h) => !h.arxivId && h.doi).length;
  const unresolved = hits.filter((h) => !h.arxivId && !h.doi).length;
  const arxivTotal = arxivOnly + arxivPlusDoi;

  console.log(`Total: ${hits.length}`);
  console.log(`  arxiv resolved (readable full-text): ${arxivTotal} (${arxivOnly} arxiv-only, ${arxivPlusDoi} arxiv+doi)`);
  console.log(`  doi only:      ${doiOnly}`);
  console.log(`  unresolved:    ${unresolved}\n`);

  console.log(`Per-landmark trail:`);
  for (const h of hits) {
    const marker = h.arxivId ? "✅" : h.doi ? "📄" : "❌";
    console.log(`\n${marker} ${h.title}${h.titleEn && h.titleEn !== h.title ? ` (en: ${h.titleEn})` : ""}`);
    console.log(`   authors: ${h.authors.join(", ")}  year=${h.year ?? "?"}`);
    console.log(`   arxivId: ${h.arxivId ?? "(none)"}  doi: ${h.doi ?? "(none)"}`);
    for (const a of h.resolution.arxivAttempts) console.log(`   arxiv trail: ${a}`);
    for (const a of h.resolution.crossrefAttempts) console.log(`   crossref trail: ${a}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
