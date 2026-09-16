import { describe, it, expect, vi, beforeAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Radix Popover/Tooltip rely on pointer capture + ResizeObserver, absent in jsdom.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();

  global.ResizeObserver = class ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
});

import { render } from '../test-utils';
import {
  MultiSelectFilter,
  type MultiSelectOption,
} from '@/components/question-bank/filters/MultiSelectFilter';

const LONG_LABEL =
  'Κατανόηση και ερμηνεία σύνθετων μαθηματικών εννοιών σε πραγματικά προβλήματα';

const options: MultiSelectOption[] = [
  { value: 'comp-1', label: LONG_LABEL, count: 3 },
  { value: 'comp-2', label: 'Algebra' },
];

function renderFilter(props: Partial<React.ComponentProps<typeof MultiSelectFilter>> = {}) {
  return render(
    <MultiSelectFilter
      label="Competency"
      options={options}
      selected={new Set()}
      onChange={vi.fn()}
      testId="competency-filter"
      {...props}
    />,
  );
}

describe('MultiSelectFilter tooltips', () => {
  it('does not add an extra tab stop on the label text', async () => {
    const user = userEvent.setup();
    renderFilter();

    await user.click(screen.getByTestId('competency-filter'));

    const row = await screen.findByTestId('competency-filter-option-comp-1');
    const label = within(row).getByText(LONG_LABEL);
    // Keyboard focus should land on the row's Checkbox only — the label
    // text itself must not be an independent tab stop (avoids a second,
    // non-actionable Tab press per option).
    expect(label).not.toHaveAttribute('tabindex');
  });

  it('reveals the full label in a tooltip when the row Checkbox is focused', async () => {
    const user = userEvent.setup();
    renderFilter();

    await user.click(screen.getByTestId('competency-filter'));

    const row = await screen.findByTestId('competency-filter-option-comp-1');
    within(row).getByRole('checkbox').focus();

    await waitFor(() => {
      // Radix renders the open tooltip content with role="tooltip"
      // containing the complete (untruncated) label text.
      expect(
        screen.getByRole('tooltip', { name: LONG_LABEL }),
      ).toBeInTheDocument();
    });
  });
});
