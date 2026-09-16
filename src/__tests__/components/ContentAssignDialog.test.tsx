import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { ContentAssignDialog } from '@/components/ContentAssignDialog';
import type { CourseClass, AssignSelection } from '@/types/content-assignments';

const classes: CourseClass[] = [
  {
    id: 'cls-1',
    name: 'Math 101',
    grade_level_id: null,
    section_name: null,
    category: null,
    academic_period: null,
    offering_id: 'off-1',
  },
];

const onSave = vi.fn().mockResolvedValue(undefined);
const onOpenChange = vi.fn();

beforeEach(() => {
  onSave.mockClear();
  onOpenChange.mockClear();
});

describe('ContentAssignDialog', () => {
  it('falls back to legacy save shape when no groups exist', async () => {
    render(
      <ContentAssignDialog
        open
        onOpenChange={onOpenChange}
        classes={classes}
        currentAssignedOfferingIds={new Set()}
        onSave={onSave}
        saving={false}
      />
    );

    fireEvent.click(screen.getByLabelText('Math 101'));
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const arg = onSave.mock.calls[0][0];
    expect(arg).toBeInstanceOf(Set);
    expect((arg as Set<string>).has('off-1')).toBe(true);
  });

  it('emits a group-aware selection when groups are available', async () => {
    render(
      <ContentAssignDialog
        open
        onOpenChange={onOpenChange}
        classes={classes}
        currentAssignedTargets={[]}
        groupsByOffering={{
          'off-1': [{ id: 'g-1', offering_id: 'off-1', name: 'Advanced' }],
        }}
        onSave={onSave}
        saving={false}
      />
    );

    fireEvent.click(screen.getByLabelText('Math 101'));
    fireEvent.click(screen.getByLabelText('Advanced'));
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const arg = onSave.mock.calls[0][0] as AssignSelection;
    expect(arg.kind).toBe('targets');
    if (arg.kind !== 'targets') return;
    const sel = arg.perOffering.get('off-1');
    expect(sel?.wholeClass).toBe(true);
    expect(sel?.groupIds.has('g-1')).toBe(true);
  });

  it('renders individual groups under a Students sub-heading using the owner label, and round-trips selection', () => {
    render(
      <ContentAssignDialog
        open
        onOpenChange={onOpenChange}
        classes={classes}
        currentAssignedTargets={[]}
        groupsByOffering={{
          'off-1': [
            { id: 'g-1', offering_id: 'off-1', name: 'Advanced', is_individual: false },
            { id: 'ig-1', offering_id: 'off-1', name: '_individual_u-1', is_individual: true, owner_label: 'John Bar' },
          ],
        }}
        onSave={onSave}
        saving={false}
      />
    );

    // Both sub-headings present.
    expect(screen.getByText('Groups')).toBeInTheDocument();
    expect(screen.getByText('Students')).toBeInTheDocument();
    // Student label uses owner_label, NOT the raw `_individual_<uuid>` name.
    expect(screen.getByLabelText(/John Bar/)).toBeInTheDocument();
    expect(screen.queryByText('_individual_u-1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/John Bar/));
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const arg = onSave.mock.calls[0][0] as AssignSelection;
    expect(arg.kind).toBe('targets');
    if (arg.kind !== 'targets') return;
    const sel = arg.perOffering.get('off-1');
    expect(sel?.wholeClass).toBe(false);
    expect(sel?.groupIds.has('ig-1')).toBe(true);
  });

  it('round-trips an existing individual-group assignment as checked', () => {
    render(
      <ContentAssignDialog
        open
        onOpenChange={onOpenChange}
        classes={classes}
        currentAssignedTargets={[
          { offering_id: 'off-1', group_id: 'ig-1' },
        ]}
        groupsByOffering={{
          'off-1': [
            { id: 'ig-1', offering_id: 'off-1', name: '_individual_u-1', is_individual: true, owner_label: 'John Bar' },
          ],
        }}
        onSave={onSave}
        saving={false}
      />
    );

    expect((screen.getByLabelText(/John Bar/) as HTMLInputElement).getAttribute('data-state')).toBe('checked');
  });

  it('initializes with existing targets', () => {
    render(
      <ContentAssignDialog
        open
        onOpenChange={onOpenChange}
        classes={classes}
        currentAssignedTargets={[
          { offering_id: 'off-1', group_id: null },
          { offering_id: 'off-1', group_id: 'g-1' },
        ]}
        groupsByOffering={{
          'off-1': [{ id: 'g-1', offering_id: 'off-1', name: 'Advanced' }],
        }}
        onSave={onSave}
        saving={false}
      />
    );

    expect((screen.getByLabelText('Math 101') as HTMLInputElement).getAttribute('data-state')).toBe('checked');
    expect((screen.getByLabelText('Advanced') as HTMLInputElement).getAttribute('data-state')).toBe('checked');
  });

  it('renders per-offering controls inside each class card and tracks selection', () => {
    // The study guides' per-section due date rides on this render prop; the
    // `selected` flag is what lets the caller withhold controls for a class
    // that will not be part of the save.
    const perOfferingControls = vi.fn((cls: CourseClass, selected: boolean) => (
      <span data-testid={`extra-${cls.offering_id}-${selected}`} />
    ));
    render(
      <ContentAssignDialog
        open
        onOpenChange={onOpenChange}
        classes={classes}
        currentAssignedOfferingIds={new Set()}
        onSave={onSave}
        saving={false}
        perOfferingControls={perOfferingControls}
      />
    );

    expect(screen.getByTestId('extra-off-1-false')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Math 101'));
    expect(screen.getByTestId('extra-off-1-true')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Math 101'));
    expect(screen.getByTestId('extra-off-1-false')).toBeInTheDocument();
  });

  it('keeps unsaved picks when the caller re-renders with a fresh targets array', () => {
    // Callers build `currentAssignedTargets` inline, so its identity changes on
    // every caller render — e.g. StudyGuideManager re-rendering because a due
    // date (caller state) was typed into perOfferingControls. That must not
    // reset the dialog's unsaved selection.
    const { rerender } = render(
      <ContentAssignDialog
        open
        onOpenChange={onOpenChange}
        classes={classes}
        currentAssignedTargets={[]}
        groupsByOffering={{ 'off-1': [] }}
        onSave={onSave}
        saving={false}
      />
    );

    fireEvent.click(screen.getByLabelText('Math 101'));
    expect((screen.getByLabelText('Math 101') as HTMLInputElement).getAttribute('data-state')).toBe('checked');

    rerender(
      <ContentAssignDialog
        open
        onOpenChange={onOpenChange}
        classes={classes}
        currentAssignedTargets={[]}
        groupsByOffering={{ 'off-1': [] }}
        onSave={onSave}
        saving={false}
      />
    );

    expect((screen.getByLabelText('Math 101') as HTMLInputElement).getAttribute('data-state')).toBe('checked');
  });

  it('reflects targets that arrive after opening, as long as nothing was edited', () => {
    // The dialog can open before the assignments fetch resolves; the
    // authoritative targets that arrive later must still populate the
    // selection, or saving would delete the existing assignments.
    const { rerender } = render(
      <ContentAssignDialog
        open
        onOpenChange={onOpenChange}
        classes={classes}
        currentAssignedTargets={[]}
        groupsByOffering={{ 'off-1': [] }}
        onSave={onSave}
        saving={false}
      />
    );

    expect((screen.getByLabelText('Math 101') as HTMLInputElement).getAttribute('data-state')).toBe('unchecked');

    rerender(
      <ContentAssignDialog
        open
        onOpenChange={onOpenChange}
        classes={classes}
        currentAssignedTargets={[{ offering_id: 'off-1', group_id: null }]}
        groupsByOffering={{ 'off-1': [] }}
        onSave={onSave}
        saving={false}
      />
    );

    expect((screen.getByLabelText('Math 101') as HTMLInputElement).getAttribute('data-state')).toBe('checked');
  });

  it('re-snapshots the saved targets on each reopening', () => {
    const Harness = ({ targets }: { targets: { offering_id: string; group_id: string | null }[] }) => {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(o => !o)}>toggle-dialog</button>
          <ContentAssignDialog
            open={open}
            onOpenChange={setOpen}
            classes={classes}
            currentAssignedTargets={targets}
            groupsByOffering={{ 'off-1': [] }}
            onSave={onSave}
            saving={false}
          />
        </>
      );
    };
    render(<Harness targets={[{ offering_id: 'off-1', group_id: null }]} />);

    // Uncheck without saving, then close and reopen: the saved state returns.
    fireEvent.click(screen.getByLabelText('Math 101'));
    expect((screen.getByLabelText('Math 101') as HTMLInputElement).getAttribute('data-state')).toBe('unchecked');

    fireEvent.click(screen.getByText('toggle-dialog'));
    fireEvent.click(screen.getByText('toggle-dialog'));
    expect((screen.getByLabelText('Math 101') as HTMLInputElement).getAttribute('data-state')).toBe('checked');
  });
});
