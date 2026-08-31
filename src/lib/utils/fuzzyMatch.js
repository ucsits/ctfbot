/**
 * Fuzzy title/description matching for tasks.
 *
 * Personnel complete or cancel tasks by name, not just UUID. Because a title
 * query can be a typo, a partial phrase, or a paraphrase of the description,
 * we score candidates with a lightweight, dependency-free algorithm:
 *
 *   1. Token overlap — how many query tokens appear (as words or substrings)
 *      in the searchable text, weighted by coverage of the query.
 *   2. Subsequence bonus — query characters appearing in order (e.g. "upd
 *      doc" matching "Update documentation") reward partial-but-ordered input.
 *   3. Exact-title / prefix-title bonuses — an exact or prefix match on the
 *      title alone outranks a description-only match, so "Fix bug" beats a
 *      task that merely mentions "fix bug" in its description.
 *
 * The score is normalized to [0, 1]. A hard threshold (MIN_FUZZY_SCORE)
 * separates plausible matches from noise; below it we report "no task found"
 * rather than risk marking the wrong task done.
 *
 * @module utils/fuzzyMatch
 */

/**
 * Minimum score a candidate must reach to be considered a match.
 * Calibrated so that: a full exact title match ≈ 1.0, a prefix title match
 * ("deploy" → "deploy staging") > 0.65, a single-typo title match > 0.55,
 * and a weak description-only overlap ("the" vs an unrelated task) stays
 * well below 0.35.
 */
const MIN_FUZZY_SCORE = 0.4;

/**
 * When the top two candidates are within this band, the query is ambiguous
 * and the caller should show a picker (one button per candidate) instead of
 * guessing.
 */
const AMBIGUITY_BAND = 0.08;

/**
 * Normalize text for comparison: lowercase, collapse whitespace.
 * @param {string} text
 * @returns {string}
 */
function canonicalize(text) {
	return String(text || '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Score how well a query matches a single task's title + description.
 *
 * @param {string} query Raw user query (title/description fragment).
 * @param {Object} task Task row with `title` and optional `description`.
 * @returns {number} Score in [0, 1]. Higher is better.
 */
function scoreTask(query, task) {
	const q = canonicalize(query);
	if (!q) {
		return 0;
	}
	const title = canonicalize(task.title);
	const description = canonicalize(task.description);

	// Exact title match — the clearest possible hit.
	if (title === q) {
		return 1;
	}
	// Title starts with the query ("deploy" → "deploy staging").
	if (title.startsWith(q)) {
		return 0.85;
	}

	const queryTokens = q.split(' ');
	let tokenScore = 0;
	let matchedWeight = 0;
	let totalWeight = 0;

	for (const token of queryTokens) {
		if (!token) {
			continue;
		}
		const weight = token.length;
		totalWeight += weight;
		const inTitle = title.includes(token);
		const inDescription = description.includes(token);
		if (inTitle || inDescription) {
			// Title hits weigh more than description hits.
			tokenScore += weight * (inTitle ? 1 : 0.5);
			matchedWeight += weight;
		}
	}

	// Coverage of the query by matched tokens (0..1).
	const coverage = totalWeight ? matchedWeight / totalWeight : 0;
	// Average per-token match quality (exact word beats substring).
	const perToken = totalWeight ? tokenScore / totalWeight : 0;

	// Subsequence bonus: query characters in order anywhere in title/desc.
	// Rewards "upd doc" → "update documentation" even without word overlap.
	let subseq = 0;
	if (q.length >= 3 && !coverage) {
		const haystack = `${title} ${description}`;
		let qi = 0;
		for (const ch of haystack) {
			if (ch === q[qi]) {
				qi += 1;
				if (qi === q.length) {
					subseq = 0.3;
					break;
				}
			}
		}
	}

	// Title-prefix handled above; also give a smaller bonus when a significant
	// fraction of the query tokens hit the title (title is a stronger signal).
	const titleBoost = coverage >= 0.5 && matchedWeight > 0 ? 0.1 : 0;

	const score = coverage * 0.7 + perToken * 0.2 + titleBoost + subseq;
	return Math.min(1, Math.round(score * 100) / 100);
}

/**
 * Resolve a fuzzy query to candidate tasks.
 *
 * @param {string} query Raw user query.
 * @param {Array<Object>} tasks Pending task rows (title, description, ...).
 * @param {Object} [options]
 * @param {number} [options.minScore] Override MIN_FUZZY_SCORE.
 * @returns {Array<Object>} Candidates sorted by score (desc), each with a
 *   `score` property. Empty array when nothing clears the threshold.
 */
function resolveTaskCandidates({ query, tasks, minScore = MIN_FUZZY_SCORE }) {
	if (!query || !Array.isArray(tasks) || tasks.length === 0) {
		return [];
	}

	const scored = tasks
		.map(task => ({ ...task, score: scoreTask(query, task) }))
		.filter(c => c.score >= minScore)
		.sort((a, b) => b.score - a.score);

	if (scored.length === 0) {
		return [];
	}

	// Ambiguity handling: if the top two candidates are within the band, keep
	// them all so the caller can offer a picker. Otherwise only the clear
	// winner is returned (it will still be confirmed before execution).
	if (scored.length >= 2 && scored[0].score - scored[1].score <= AMBIGUITY_BAND) {
		return scored;
	}
	return [scored[0]];
}

module.exports = {
	MIN_FUZZY_SCORE,
	AMBIGUITY_BAND,
	canonicalize,
	scoreTask,
	resolveTaskCandidates
};
