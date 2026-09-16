/**
 * The institution the user is currently working in, held in `sessionStorage`.
 *
 * Twelve call sites across five pages and `useUserInstitution` write this key,
 * and same-tab `sessionStorage` writes fire no event — so anything that needs to
 * *react* to a switch (rather than merely read the value on its next render) has
 * no way to find out. `useUserInstitution` re-reads it only when the user id
 * changes, which an institution switch does not.
 *
 * This module keeps the storage key as the single source of truth and adds a
 * subscription on top, so writers stay a one-line call and the ~8 readers that
 * do not need to react go on reading `sessionStorage` directly.
 *
 * On storage failure it deliberately does nothing clever. An earlier revision
 * held a rejected write in memory so the locale would still follow the switch;
 * review surfaced three successive defects from that one decision, ending in the
 * one that matters: `LocaleProvider` would read the new institution from memory
 * while every direct reader still read the old one from storage, so the UI
 * language and the working institution could disagree. A switch that storage
 * rejects simply has not happened, and every reader agreeing on that is worth
 * more than the locale alone staying current. A `sessionStorage` that rejects
 * writes breaks institution selection and auth long before it breaks i18n.
 */
const KEY = "selectedInstitutionId";

type Listener = () => void;

const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getSelectedInstitutionId(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setSelectedInstitutionId(id: string): void {
  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    // Storage disabled by policy or out of quota. The switch did not happen, so
    // there is nothing to announce — every reader, this module included, still
    // sees the previous institution. Notifying here would claim a change that
    // did not occur.
    return;
  }
  emit();
}

export function clearSelectedInstitutionId(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    return;
  }
  emit();
}

/** Subscribe to changes made through this module. Returns an unsubscribe fn. */
export function subscribeSelectedInstitution(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
