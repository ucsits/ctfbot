import { describe, it, expect } from 'vitest';
import {
	MIN_FUZZY_SCORE,
	AMBIGUITY_BAND,
	canonicalize,
	scoreTask,
	resolveTaskCandidates
} from '../../src/lib/utils/fuzzyMatch.js';

const tasks = [
	{ task_id: 't-1', title: 'Deploy staging server', description: 'Ship the new build to staging before Friday.' },
	{ task_id: 't-2', title: 'Update documentation', description: 'Rewrite the onboarding docs for the new API.' },
	{ task_id: 't-3', title: 'Fix login bug', description: 'Users cannot log in after the last release.' },
	{ task_id: 't-4', title: 'Buy coffee beans', description: 'Pick up beans for the office machine.' }
];

describe('canonicalize', () => {
	it('lowercases and collapses whitespace', () => {
		expect(canonicalize('  Deploy   Staging   ')).toBe('deploy staging');
	});

	it('handles empty / null input', () => {
		expect(canonicalize(null)).toBe('');
		expect(canonicalize('')).toBe('');
	});
});

describe('scoreTask', () => {
	it('gives exact title matches the maximum score', () => {
		expect(scoreTask('Deploy staging server', tasks[0])).toBe(1);
		expect(scoreTask('deploy staging server', tasks[0])).toBe(1);
	});

	it('is case-insensitive', () => {
		expect(scoreTask('FIX LOGIN BUG', tasks[2])).toBeGreaterThan(0.8);
	});

	it('rewards title prefix matches', () => {
		expect(scoreTask('deploy', tasks[0])).toBeGreaterThan(0.5);
		// Prefix title beats a description-only mention elsewhere
		expect(scoreTask('deploy', tasks[0])).toBeGreaterThan(scoreTask('deploy', tasks[1]));
	});

	it('matches tokens inside the description', () => {
		// "onboarding docs" lives in the description of t-2
		expect(scoreTask('onboarding docs', tasks[1])).toBeGreaterThan(MIN_FUZZY_SCORE);
	});

	it('tolerates a single typo via substring tokens', () => {
		// "fix login bu" — trailing typo/abbreviation still matches t-3
		expect(scoreTask('fix login bu', tasks[2])).toBeGreaterThan(MIN_FUZZY_SCORE);
	});

	it('scores unrelated text at or near zero', () => {
		expect(scoreTask('quantum banana', tasks[0])).toBeLessThan(MIN_FUZZY_SCORE);
	});

	it('returns 0 for empty queries', () => {
		expect(scoreTask('', tasks[0])).toBe(0);
		expect(scoreTask('   ', tasks[0])).toBe(0);
	});
});

describe('resolveTaskCandidates', () => {
	it('returns the exact match as the sole candidate', () => {
		const result = resolveTaskCandidates({ query: 'Buy coffee beans', tasks });
		expect(result).toHaveLength(1);
		expect(result[0].task_id).toBe('t-4');
		expect(result[0].score).toBe(1);
	});

	it('returns [] when nothing clears the threshold', () => {
		expect(resolveTaskCandidates({ query: 'zzzz unrelated gibberish', tasks })).toEqual([]);
		expect(resolveTaskCandidates({ query: '', tasks })).toEqual([]);
		expect(resolveTaskCandidates({ query: 'coffee', tasks: [] })).toEqual([]);
	});

	it('returns multiple candidates (sorted desc) when the top two are close', () => {
		// "docs" hits t-2's title prefix AND t-2/t-1 descriptions — engineered
		// here with two titles sharing a prefix to force a tight band.
		const twinTasks = [
			{ task_id: 'a-1', title: 'Prepare release notes', description: '' },
			{ task_id: 'a-2', title: 'Prepare release checklist', description: '' }
		];
		const result = resolveTaskCandidates({ query: 'prepare release', tasks: twinTasks });
		expect(result.length).toBeGreaterThanOrEqual(2);
		// Sorted descending by score
		for (let i = 1; i < result.length; i++) {
			expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
		}
		// And they are within the ambiguity band of each other
		expect(result[0].score - result[result.length - 1].score).toBeLessThanOrEqual(AMBIGUITY_BAND);
	});

	it('returns only the winner when the gap is large', () => {
		const result = resolveTaskCandidates({ query: 'fix login bug', tasks });
		expect(result).toHaveLength(1);
		expect(result[0].task_id).toBe('t-3');
	});

	it('sorts candidates and attaches score without mutating input tasks', () => {
		const snapshot = JSON.stringify(tasks);
		const result = resolveTaskCandidates({ query: 'login', tasks });
		expect(JSON.stringify(tasks)).toBe(snapshot);
		expect(result.every(c => typeof c.score === 'number')).toBe(true);
	});

	it('respects a custom minScore override', () => {
		const strict = resolveTaskCandidates({ query: 'banana', tasks, minScore: 0.9 });
		expect(strict).toEqual([]);
	});
});

describe('threshold calibration', () => {
	it('MIN_FUZZY_SCORE is a sane value in (0, 1)', () => {
		expect(MIN_FUZZY_SCORE).toBeGreaterThan(0);
		expect(MIN_FUZZY_SCORE).toBeLessThan(1);
	});
});
