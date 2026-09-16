import { describe, it, expect } from 'vitest';
import {
  GRADE_OPTIONS,
  GREEK_SCHOOL_LEVELS,
  SECTION_LETTERS,
  getGradeLabel,
  gradeOptionsForLevels,
  getSectionDisplayName,
  buildClassDisplayName,
  buildCompactClassDisplayName,
  buildStarterClasses,
  isGreekGradeLevel,
  nextGenericSectionName,
} from '@/lib/greek-school';

describe('greek-school', () => {
  describe('GRADE_OPTIONS', () => {
    it('should have 12 grade options', () => {
      expect(GRADE_OPTIONS).toHaveLength(12);
    });

    it('should have 6 dimotiko grades', () => {
      const dimotiko = GRADE_OPTIONS.filter((g) => g.level === 'dimotiko');
      expect(dimotiko).toHaveLength(6);
    });

    it('should have 3 gymnasio grades', () => {
      const gymnasio = GRADE_OPTIONS.filter((g) => g.level === 'gymnasio');
      expect(gymnasio).toHaveLength(3);
    });

    it('should have 3 lykeio grades', () => {
      const lykeio = GRADE_OPTIONS.filter((g) => g.level === 'lykeio');
      expect(lykeio).toHaveLength(3);
    });
  });

  describe('GREEK_SCHOOL_LEVELS', () => {
    it('should have 3 school levels', () => {
      expect(GREEK_SCHOOL_LEVELS).toHaveLength(3);
    });

    it('should include dimotiko, gymnasio, and lykeio', () => {
      const ids = GREEK_SCHOOL_LEVELS.map((l) => l.id);
      expect(ids).toEqual(['dimotiko', 'gymnasio', 'lykeio']);
    });
  });

  describe('getGradeLabel', () => {
    it('should return Greek label by default (el)', () => {
      expect(getGradeLabel('dimotiko_1', 'el')).toBe('1η Δημοτικού');
    });

    it('should return English label when lang is en', () => {
      expect(getGradeLabel('dimotiko_1', 'en')).toBe('1st Grade Primary');
    });

    it('should fall back to the grade value for unknown grades', () => {
      expect(getGradeLabel('unknown', 'el')).toBe('unknown');
    });
  });

  describe('gradeOptionsForLevels', () => {
    it('should return only grades for specified school levels', () => {
      const result = gradeOptionsForLevels(['dimotiko']);
      expect(result).toHaveLength(6);
      expect(result.every((g) => g.level === 'dimotiko')).toBe(true);
    });

    it('should return grades for multiple school levels', () => {
      const result = gradeOptionsForLevels(['gymnasio', 'lykeio']);
      expect(result).toHaveLength(6);
    });

    it('should return all grades for all levels', () => {
      const result = gradeOptionsForLevels(['dimotiko', 'gymnasio', 'lykeio']);
      expect(result).toHaveLength(12);
    });
  });

  describe('getSectionDisplayName', () => {
    it('should combine year number and section name', () => {
      expect(getSectionDisplayName('dimotiko_1', 'Α')).toBe('1Α');
    });

    it('should use year from grade option', () => {
      expect(getSectionDisplayName('gymnasio_2', 'Β')).toBe('2Β');
    });

    it('should return section name for unknown grade', () => {
      expect(getSectionDisplayName('unknown', 'Α')).toBe('Α');
    });
  });

  describe('buildClassDisplayName', () => {
    it('should build display name from grade_level and section_name', () => {
      expect(buildClassDisplayName({ grade_level: 'dimotiko_1', section_name: 'Α' }))
        .toBe('1η Δημοτικού – Τμήμα 1Α');
    });

    it('should append category when non-null', () => {
      expect(buildClassDisplayName({ grade_level: 'dimotiko_1', section_name: 'Α', category: 'English' }))
        .toBe('1η Δημοτικού – Τμήμα 1Α (English)');
    });

    it('should not append category when null', () => {
      expect(buildClassDisplayName({ grade_level: 'dimotiko_1', section_name: 'Α', category: null }))
        .toBe('1η Δημοτικού – Τμήμα 1Α');
    });

    it('should fall back to class name when grade_level or section_name is missing', () => {
      expect(buildClassDisplayName({ name: 'My Class' })).toBe('My Class');
      expect(buildClassDisplayName({ grade_level: 'dimotiko_1', name: 'My Class' })).toBe('My Class');
    });

    it('should return "Unknown" when no useful fields are present', () => {
      expect(buildClassDisplayName({})).toBe('Unknown');
      expect(buildClassDisplayName(null)).toBe('Unknown');
      expect(buildClassDisplayName(undefined)).toBe('Unknown');
    });
  });

  describe('buildCompactClassDisplayName', () => {
    it('should return only section part when grade_level and section_name are present', () => {
      expect(buildCompactClassDisplayName({ grade_level: 'dimotiko_1', section_name: 'Α' }))
        .toBe('Τμήμα 1Α');
    });

    it('should append category when non-null', () => {
      expect(buildCompactClassDisplayName({ grade_level: 'dimotiko_1', section_name: 'Α', category: 'PT' }))
        .toBe('Τμήμα 1Α (PT)');
    });

    it('should not append category when null', () => {
      expect(buildCompactClassDisplayName({ grade_level: 'dimotiko_1', section_name: 'Α', category: null }))
        .toBe('Τμήμα 1Α');
    });

    it('should return compact name for gymnasio', () => {
      expect(buildCompactClassDisplayName({ grade_level: 'gymnasio_2', section_name: 'Β' }))
        .toBe('Τμήμα 2Β');
    });

    it('should fall back to full display name when grade_level is missing', () => {
      expect(buildCompactClassDisplayName({ name: 'My Class' })).toBe('My Class');
    });

    it('should fall back to full display name when section_name is missing', () => {
      expect(buildCompactClassDisplayName({ grade_level: 'dimotiko_1', name: 'My Class' })).toBe('My Class');
    });

    // Objects built from the `classes` table have no `grade_level` TEXT at all —
    // it is the `grade_level_id` FK — so the legacy branch never matches and
    // these used to render the stored full name instead of the section.
    it('renders the section alone for the grade_level_id shape', () => {
      expect(
        buildCompactClassDisplayName({ section_name: '1', name: '3η Λυκείου – Section 1' }),
      ).toBe('Section 1');
    });

    it('appends the category for the grade_level_id shape', () => {
      expect(
        buildCompactClassDisplayName({ section_name: '1', category: 'English', name: '3η Λυκείου – Section 1' }),
      ).toBe('Section 1 (English)');
    });

    it('does not leak the grade into the compact label', () => {
      expect(
        buildCompactClassDisplayName({ section_name: 'Α', name: '1η Δημοτικού – Τμήμα 1Α' }),
      ).not.toMatch(/Δημοτικού/);
    });

    it('should return "Unknown" when no useful fields are present', () => {
      expect(buildCompactClassDisplayName({})).toBe('Unknown');
      expect(buildCompactClassDisplayName(null)).toBe('Unknown');
      expect(buildCompactClassDisplayName(undefined)).toBe('Unknown');
    });
  });

  describe('SECTION_LETTERS', () => {
    it('should start with Α', () => {
      expect(SECTION_LETTERS[0]).toBe('Α');
    });

    it('should have 9 letters', () => {
      expect(SECTION_LETTERS).toHaveLength(9);
    });
  });

  describe('buildStarterClasses', () => {
    it('creates one section "Α" per grade for greek schools', () => {
      const classes = buildStarterClasses('greek_school', ['gymnasio'], 'el', 'inst-1', 'user-1');
      expect(classes).toHaveLength(3);
      expect(classes.every((c) => c.section_name === 'Α')).toBe(true);
      expect(classes.every((c) => c.grade_code.startsWith('gymnasio_'))).toBe(true);
      expect(classes.every((c) => c.institution_id === 'inst-1' && c.created_by === 'user-1')).toBe(true);
    });

    it('creates a default "General" grade with one section for generic institutions', () => {
      const classes = buildStarterClasses('generic', [], 'en', 'inst-1', 'user-1');
      expect(classes).toHaveLength(1);
      expect(classes[0]).toMatchObject({
        name: 'General - Section 1',
        institution_id: 'inst-1',
        grade_code: 'General',
        section_name: '1',
        is_active: true,
        created_by: 'user-1',
      });
    });

    it('ignores schoolLevels for generic institutions', () => {
      const classes = buildStarterClasses('generic', ['dimotiko', 'lykeio'], 'en', 'inst-1', 'user-1');
      expect(classes).toHaveLength(1);
      expect(classes[0].grade_code).toBe('General');
    });

    it('returns no classes for a greek school with no levels', () => {
      expect(buildStarterClasses('greek_school', [], 'el', 'inst-1', 'user-1')).toHaveLength(0);
    });
  });

  describe('isGreekGradeLevel', () => {
    it('is true for taxonomy grades and false for free-text/null', () => {
      expect(isGreekGradeLevel('gymnasio_1')).toBe(true);
      expect(isGreekGradeLevel('General')).toBe(false);
      expect(isGreekGradeLevel(null)).toBe(false);
      expect(isGreekGradeLevel('')).toBe(false);
    });
  });

  describe('nextGenericSectionName', () => {
    it('returns the next integer for generic grades', () => {
      expect(nextGenericSectionName([])).toBe('1');
      expect(nextGenericSectionName(['1', '2'])).toBe('3');
      // ignores non-numeric and nullish, uses max + 1
      expect(nextGenericSectionName(['1', 'Morning', null, '4'])).toBe('5');
    });
  });

  describe('generic grade display', () => {
    it('buildClassDisplayName formats a generic grade with "Section"', () => {
      expect(buildClassDisplayName({ grade_level: 'General', section_name: '2' })).toBe(
        'General – Section 2',
      );
    });

    it('buildCompactClassDisplayName formats a generic section with "Section"', () => {
      expect(buildCompactClassDisplayName({ grade_level: 'Year 1', section_name: '1' })).toBe(
        'Section 1',
      );
    });
  });
});
