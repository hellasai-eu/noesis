import { describe, it, expect } from 'vitest';
import {
  createInitialTutorState,
  createStateUpdate,
  TUTOR_STATE_SCHEMA_VERSION,
  type TutorState,
  type TutorStateCore,
} from '@/types/tutor-state';

describe('tutor-state', () => {
  describe('TUTOR_STATE_SCHEMA_VERSION', () => {
    it('should be a positive integer', () => {
      expect(TUTOR_STATE_SCHEMA_VERSION).toBeGreaterThan(0);
      expect(Number.isInteger(TUTOR_STATE_SCHEMA_VERSION)).toBe(true);
    });
  });

  describe('createInitialTutorState', () => {
    it('should create an empty initial state', () => {
      const state = createInitialTutorState();

      expect(state).toBeDefined();
      expect(state.decision).toBeUndefined();
      expect(state.state_update).toBeDefined();
      expect(state.meta).toBeDefined();
    });

    it('should have empty arrays for list fields', () => {
      const state = createInitialTutorState();

      expect(state.state_update?.known).toEqual([]);
      expect(state.state_update?.gaps).toEqual([]);
      expect(state.state_update?.misconceptions).toEqual([]);
    });

    it('should have zero values for numeric fields', () => {
      const state = createInitialTutorState();

      expect(state.state_update?.hint_level).toBe(0);
      expect(state.state_update?.frustration).toBe(0);
    });

    it('should start at the lowest progress level', () => {
      // The initial state is what a session with no history looks like, and
      // `progress_level` never goes down — starting it anywhere else would
      // credit a student with knowledge they have not shown.
      const state = createInitialTutorState();

      expect(state.state_update?.progress_level).toBe('intro');
      expect(state.state_update?.difficulty).toBe('same');
    });

    it('should have answer_allowed set to false', () => {
      const state = createInitialTutorState();

      expect(state.state_update?.answer_allowed).toBe(false);
    });

    it('should return a new object each time', () => {
      const state1 = createInitialTutorState();
      const state2 = createInitialTutorState();

      expect(state1).not.toBe(state2);
      expect(state1.state_update).not.toBe(state2.state_update);
    });
  });

  describe('createStateUpdate', () => {
    it('should merge updates with empty current state', () => {
      const updates: Partial<TutorStateCore> = {
        goal: 'Test goal',
        frustration: 0.5,
      };

      const result = createStateUpdate(null, updates);

      expect(result.goal).toBe('Test goal');
      expect(result.frustration).toBe(0.5);
    });

    it('should merge updates with existing state', () => {
      const currentState: TutorState = {
        decision: 'ASK',
        state_update: {
          goal: 'Original goal',
          subject: 'physics',
          frustration: 0.3,
          hint_level: 1,
        },
      };

      const updates: Partial<TutorStateCore> = {
        goal: 'Updated goal',
        frustration: 0.5,
      };

      const result = createStateUpdate(currentState, updates);

      expect(result.goal).toBe('Updated goal');
      expect(result.subject).toBe('physics');
      expect(result.frustration).toBe(0.5);
      expect(result.hint_level).toBe(1);
    });

    it('should preserve arrays from current state', () => {
      const currentState: TutorState = {
        state_update: {
          known: ['fact1', 'fact2'],
          gaps: ['gap1'],
        },
      };

      const updates: Partial<TutorStateCore> = {
        goal: 'New goal',
      };

      const result = createStateUpdate(currentState, updates);

      expect(result.known).toEqual(['fact1', 'fact2']);
      expect(result.gaps).toEqual(['gap1']);
      expect(result.goal).toBe('New goal');
    });

    it('should allow overwriting arrays', () => {
      const currentState: TutorState = {
        state_update: {
          known: ['fact1', 'fact2'],
        },
      };

      const updates: Partial<TutorStateCore> = {
        known: ['new fact'],
      };

      const result = createStateUpdate(currentState, updates);

      expect(result.known).toEqual(['new fact']);
    });

    it('should handle undefined current state', () => {
      const updates: Partial<TutorStateCore> = {
        judgement: 'CORRECT',
      };

      const result = createStateUpdate(undefined as unknown as TutorState | null, updates);

      expect(result.judgement).toBe('CORRECT');
    });
  });

  describe('Type safety', () => {
    it('should enforce valid decision values', () => {
      const state: TutorState = {
        decision: 'STOP',
      };
      expect(['STOP', 'ASK', 'HINT', 'WORKED_STEP']).toContain(state.decision);
    });

    it('should enforce valid judgement values', () => {
      const state: TutorState = {
        state_update: {
          judgement: 'CORRECT',
        },
      };
      expect(['CORRECT', 'PARTIAL', 'INCORRECT']).toContain(state.state_update?.judgement);
    });

    it('should enforce valid hint_level range', () => {
      const state: TutorState = {
        state_update: {
          hint_level: 4,
        },
      };
      expect(state.state_update?.hint_level).toBeGreaterThanOrEqual(0);
      expect(state.state_update?.hint_level).toBeLessThanOrEqual(4);
    });
  });
});
