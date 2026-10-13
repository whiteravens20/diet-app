// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Loaded before every file of integration tests: the test applications check
 * what they answer against what their routes declare, and a test in which an
 * answer was outside it fails, whatever else the test looked at.
 */
import { afterEach, expect } from 'vitest';
import { answersOutsideTheContract, holdAnswers } from './answers-check.js';

holdAnswers();

afterEach(() => {
  expect(answersOutsideTheContract()).toEqual([]);
});
