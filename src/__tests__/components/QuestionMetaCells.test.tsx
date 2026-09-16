import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VoteBadges, AuthorCell } from '@/components/QuestionMetaCells';

describe('VoteBadges', () => {
  it('renders both badges when both counts are 0 (per #617 — never hide the 0/0 case)', () => {
    render(<VoteBadges upvotes={0} downvotes={0} />);
    const cell = screen.getByTestId('vote-badges');
    expect(cell.textContent).toContain('0');
    // Two badges present (upvote + downvote), each carrying a `0`.
    const zeroCount = (cell.textContent?.match(/0/g) || []).length;
    expect(zeroCount).toBe(2);
  });

  it('renders the actual non-zero counts', () => {
    render(<VoteBadges upvotes={7} downvotes={3} />);
    const cell = screen.getByTestId('vote-badges');
    expect(cell.textContent).toContain('7');
    expect(cell.textContent).toContain('3');
  });
});

describe('AuthorCell', () => {
  it('falls back to "AI Generated" when createdBy is null', () => {
    render(<AuthorCell createdBy={null} authorName={null} />);
    expect(screen.getByTestId('author-cell').textContent).toBe('AI Generated');
  });

  it('falls back to "Unknown" when createdBy is set but authorName is missing', () => {
    render(<AuthorCell createdBy="user-uuid" authorName={null} />);
    expect(screen.getByTestId('author-cell').textContent).toBe('Unknown');
  });

  it('renders the author name when available', () => {
    render(<AuthorCell createdBy="user-uuid" authorName="Jane Smith" />);
    expect(screen.getByTestId('author-cell').textContent).toBe('Jane Smith');
  });
});
