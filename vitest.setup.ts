import '@testing-library/jest-dom/vitest';
// Initialise the i18next singleton for every test file. Components call
// `useTranslation` without a provider, so without this they render raw keys.
// jsdom reports `en-US`, and nothing writes the locale key to localStorage in
// tests, so the resolved test locale is deterministically `en`.
import './src/i18n';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver — must be a real class so `new ResizeObserver(...)` works
// (Radix's useSize calls it as a constructor).
global.ResizeObserver = class ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
  root: null,
  rootMargin: '',
  thresholds: [],
}));

// Mock scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Pointer capture: jsdom implements none of it, and Radix's Select trigger
// calls hasPointerCapture on pointerdown — without these a test that opens a
// dropdown dies in the event handler rather than in an assertion.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
}

// Mock crypto.randomUUID
if (!global.crypto) {
  global.crypto = {} as Crypto;
}
global.crypto.randomUUID = vi.fn(() => 'test-uuid-12345678');

// Mock sessionStorage
const mockSessionStorage: { [key: string]: string } = {};
Object.defineProperty(window, 'sessionStorage', {
  value: {
    getItem: vi.fn((key: string) => mockSessionStorage[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      mockSessionStorage[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete mockSessionStorage[key];
    }),
    clear: vi.fn(() => {
      Object.keys(mockSessionStorage).forEach(key => delete mockSessionStorage[key]);
    }),
  },
});

// Mock window.location
Object.defineProperty(window, 'location', {
  value: {
    origin: 'http://localhost:3000',
    href: 'http://localhost:3000/',
    pathname: '/',
    search: '',
    hash: '',
    assign: vi.fn(),
    replace: vi.fn(),
    reload: vi.fn(),
  },
  writable: true,
});
