import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AssignedClassesBadges } from '@/components/AssignedClassesBadges';
import type { CourseClass } from '@/types/content-assignments';

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

describe('AssignedClassesBadges', () => {
  it('renders the placeholder when nothing is assigned', () => {
    render(
      <TooltipProvider>
        <AssignedClassesBadges classes={classes} assignedTargets={[]} />
      </TooltipProvider>
    );
    expect(screen.getByText(/Not assigned/i)).toBeInTheDocument();
  });

  it('renders a plain class badge for a whole-class target', () => {
    render(
      <TooltipProvider>
        <AssignedClassesBadges
          classes={classes}
          assignedTargets={[{ offering_id: 'off-1', group_id: null }]}
        />
      </TooltipProvider>
    );
    expect(screen.getByText('Math 101')).toBeInTheDocument();
    expect(screen.queryByText(/→/)).not.toBeInTheDocument();
  });

  it('renders a Class → Group badge when group-scoped', () => {
    render(
      <TooltipProvider>
        <AssignedClassesBadges
          classes={classes}
          assignedTargets={[{ offering_id: 'off-1', group_id: 'g-1' }]}
          groupsByOffering={{
            'off-1': [{ id: 'g-1', offering_id: 'off-1', name: 'Advanced' }],
          }}
        />
      </TooltipProvider>
    );
    expect(screen.getByText('Math 101 → Advanced')).toBeInTheDocument();
  });

  it('treats legacy assignedOfferingIds as whole-class targets', () => {
    render(
      <TooltipProvider>
        <AssignedClassesBadges classes={classes} assignedOfferingIds={['off-1']} />
      </TooltipProvider>
    );
    expect(screen.getByText('Math 101')).toBeInTheDocument();
  });

  // Every content menu (question bank, flashcards, cheat sheets, tutoring
  // sessions) renders this component with `compact`, where the badge must show
  // the section alone. The grade stays available in the tooltip.
  describe('compact badges', () => {
    const sectioned: CourseClass[] = [
      {
        id: 'cls-2',
        name: '3η Λυκείου – Section 1',
        grade_level_id: 'gl-1',
        section_name: '1',
        category: null,
        academic_period: null,
        offering_id: 'off-2',
      },
    ];

    it('shows the section without the grade', () => {
      render(
        <TooltipProvider>
          <AssignedClassesBadges
            classes={sectioned}
            assignedTargets={[{ offering_id: 'off-2', group_id: null }]}
            compact
          />
        </TooltipProvider>
      );
      expect(screen.getByText('Section 1')).toBeInTheDocument();
      expect(screen.queryByText(/Λυκείου/)).not.toBeInTheDocument();
    });

    it('keeps the section-only label on group-scoped targets', () => {
      render(
        <TooltipProvider>
          <AssignedClassesBadges
            classes={sectioned}
            assignedTargets={[{ offering_id: 'off-2', group_id: 'g-1' }]}
            groupsByOffering={{
              'off-2': [{ id: 'g-1', offering_id: 'off-2', name: 'Advanced' }],
            }}
            compact
          />
        </TooltipProvider>
      );
      expect(screen.getByText('Section 1 → Advanced')).toBeInTheDocument();
      expect(screen.queryByText(/Λυκείου/)).not.toBeInTheDocument();
    });
  });

  // The trailing "+" button is the visible/keyboard affordance for adding
  // sections to an already-assigned row. It is shared across every content
  // list, so a propagation regression would open the dialog twice everywhere.
  describe('add-more-sections button', () => {
    const assigned = [{ offering_id: 'off-1', group_id: null }];

    it('renders when assignments exist and onClickAssign is provided', () => {
      render(
        <TooltipProvider>
          <AssignedClassesBadges
            classes={classes}
            assignedTargets={assigned}
            onClickAssign={vi.fn()}
          />
        </TooltipProvider>
      );
      expect(
        screen.getByRole('button', { name: 'Assign to more sections' })
      ).toBeInTheDocument();
    });

    it('does not render without onClickAssign', () => {
      render(
        <TooltipProvider>
          <AssignedClassesBadges classes={classes} assignedTargets={assigned} />
        </TooltipProvider>
      );
      expect(
        screen.queryByRole('button', { name: 'Assign to more sections' })
      ).not.toBeInTheDocument();
    });

    it('is suppressed by showAddButton={false} while badges stay clickable', () => {
      const onClickAssign = vi.fn();
      render(
        <TooltipProvider>
          <AssignedClassesBadges
            classes={classes}
            assignedTargets={assigned}
            onClickAssign={onClickAssign}
            showAddButton={false}
          />
        </TooltipProvider>
      );
      expect(
        screen.queryByRole('button', { name: 'Assign to more sections' })
      ).not.toBeInTheDocument();
      // The wrapper takes over as the sole (keyboard-reachable) control.
      const wrapper = screen.getByRole('button');
      fireEvent.click(wrapper);
      expect(onClickAssign).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(wrapper, { key: 'Enter' });
      expect(onClickAssign).toHaveBeenCalledTimes(2);
    });

    it('invokes the handler exactly once per click (propagation guard)', () => {
      const onClickAssign = vi.fn();
      render(
        <TooltipProvider>
          <AssignedClassesBadges
            classes={classes}
            assignedTargets={assigned}
            onClickAssign={onClickAssign}
          />
        </TooltipProvider>
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Assign to more sections' })
      );
      expect(onClickAssign).toHaveBeenCalledTimes(1);
    });

    it('keeps a single tab stop: the wrapper is not focusable when the button renders', () => {
      render(
        <TooltipProvider>
          <AssignedClassesBadges
            classes={classes}
            assignedTargets={assigned}
            onClickAssign={vi.fn()}
          />
        </TooltipProvider>
      );
      expect(screen.getAllByRole('button')).toHaveLength(1);
    });
  });
});
