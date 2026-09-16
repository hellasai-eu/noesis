import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import CreateGenericGradeDialog from '@/components/class-management/CreateGenericGradeDialog';

const onOpenChangeNoop = vi.fn();

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function renderDialog(
  props: Partial<React.ComponentProps<typeof CreateGenericGradeDialog>> = {},
) {
  const onCreateGradeLevel = vi.fn().mockResolvedValue(undefined);
  render(
    <CreateGenericGradeDialog
      open
      onOpenChange={vi.fn()}
      existingGradeLevels={[]}
      onCreateGradeLevel={onCreateGradeLevel}
      {...props}
    />,
  );
  return { onCreateGradeLevel };
}

describe('CreateGenericGradeDialog', () => {
  it('builds N auto-numbered sections for the named grade', async () => {
    const { onCreateGradeLevel } = renderDialog();

    fireEvent.change(screen.getByLabelText('Grade Name'), {
      target: { value: 'Year 1' },
    });
    fireEvent.change(screen.getByLabelText('Number of Sections'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add grade/i }));

    await waitFor(() => expect(onCreateGradeLevel).toHaveBeenCalledTimes(1));
    const [gradeLevel, sections] = onCreateGradeLevel.mock.calls[0];
    expect(gradeLevel).toBe('Year 1');
    expect(sections).toEqual([
      { name: 'Year 1 - Section 1', section_name: '1' },
      { name: 'Year 1 - Section 2', section_name: '2' },
      { name: 'Year 1 - Section 3', section_name: '3' },
    ]);
  });

  it('trims the grade name and defaults to one section', async () => {
    const { onCreateGradeLevel } = renderDialog();

    fireEvent.change(screen.getByLabelText('Grade Name'), {
      target: { value: '  General  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add grade/i }));

    await waitFor(() => expect(onCreateGradeLevel).toHaveBeenCalledTimes(1));
    const [gradeLevel, sections] = onCreateGradeLevel.mock.calls[0];
    expect(gradeLevel).toBe('General');
    expect(sections).toHaveLength(1);
  });

  it('rejects a duplicate grade name (case-insensitive) and blocks submit', () => {
    const { onCreateGradeLevel } = renderDialog({ existingGradeLevels: ['General'] });

    fireEvent.change(screen.getByLabelText('Grade Name'), {
      target: { value: 'general' },
    });

    expect(screen.getByText(/already exists/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add grade/i })).toBeDisabled();
    expect(onCreateGradeLevel).not.toHaveBeenCalled();
  });

  it('previews section names with the same em-dash separator the UI uses for created classes', () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText('Grade Name'), {
      target: { value: 'Year 1' },
    });
    fireEvent.change(screen.getByLabelText('Number of Sections'), {
      target: { value: '2' },
    });

    expect(
      screen.getByText('Will create: Year 1 – Section 1, Year 1 – Section 2'),
    ).toBeInTheDocument();
  });

  it('clears stale form values when reopened after a cancelled flow', () => {
    const onCreateGradeLevel = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <CreateGenericGradeDialog
        open
        onOpenChange={onOpenChangeNoop}
        existingGradeLevels={[]}
        onCreateGradeLevel={onCreateGradeLevel}
      />,
    );

    fireEvent.change(screen.getByLabelText('Grade Name'), {
      target: { value: 'Draft Grade' },
    });
    fireEvent.change(screen.getByLabelText('Number of Sections'), {
      target: { value: '4' },
    });

    rerender(
      <CreateGenericGradeDialog
        open={false}
        onOpenChange={onOpenChangeNoop}
        existingGradeLevels={[]}
        onCreateGradeLevel={onCreateGradeLevel}
      />,
    );
    rerender(
      <CreateGenericGradeDialog
        open
        onOpenChange={onOpenChangeNoop}
        existingGradeLevels={[]}
        onCreateGradeLevel={onCreateGradeLevel}
      />,
    );

    expect(screen.getByLabelText('Grade Name')).toHaveValue('');
    expect(screen.getByLabelText('Number of Sections')).toHaveValue(1);
  });
});
