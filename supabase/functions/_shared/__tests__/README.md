# Tests

This directory contains unit tests for the shared moderation and LLM wrapper functions.

## Running Tests

### Run all tests
```bash
deno test --allow-net --allow-env supabase/functions/_shared/__tests__/
```

### Run specific test file
```bash
deno test --allow-net --allow-env supabase/functions/_shared/__tests__/moderation-middleware.test.ts
```

### Run tests in watch mode
```bash
deno test --watch --allow-net --allow-env supabase/functions/_shared/__tests__/
```

### Run tests with coverage
```bash
deno test --coverage=coverage --allow-net --allow-env supabase/functions/_shared/__tests__/
deno coverage coverage
```

## Test Files

- `moderation-middleware.test.ts` - Tests for the moderation middleware wrapper
- `moderation.test.ts` - Tests for the moderation API integration
- `openai-client-retry.test.ts` - Tests for rate limit retry logic
- `test-utils.ts` - Shared test utilities and mocks

## Test Coverage

The tests cover:
- ✅ Moderation middleware behavior (input/output moderation)
- ✅ Rate limit retry logic with exponential backoff
- ✅ Error handling (fail-open behavior)
- ✅ Text extraction from different LLM response formats
- ✅ Result adaptation and conversion
- ✅ Callback execution
- ✅ Edge cases (empty strings, API errors)

## CI Integration

Tests run automatically on:
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop`
- Manual workflow dispatch

See `.github/workflows/ci.yml` for CI configuration.

