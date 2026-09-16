# Quick Start - Running Tests

## First Time Setup

1. **Install Deno** (if not already installed):
   ```bash
   curl -fsSL https://deno.land/install.sh | sh
   ```

2. **Add Deno to PATH** (for zsh):
   ```bash
   echo 'export PATH="$HOME/.deno/bin:$PATH"' >> ~/.zshrc
   source ~/.zshrc
   ```

3. **Verify installation**:
   ```bash
   deno --version
   ```

## Running Tests

### Option 1: Using npm scripts (recommended)
```bash
npm run test
```

### Option 2: Using deno directly
```bash
# Run all tests
deno test --allow-net --allow-env supabase/functions/_shared/__tests__/

# Run specific test file
deno test --allow-net --allow-env supabase/functions/_shared/__tests__/moderation-middleware.test.ts
```

### Option 3: Watch mode (auto-rerun on changes)
```bash
npm run test:watch
```

## Current Session Fix

If you get "deno: command not found" in your current terminal:

```bash
export PATH="$HOME/.deno/bin:$PATH"
```

Then run your tests again.

## Troubleshooting

- **"deno: command not found"** → Add Deno to PATH (see above)
- **Type errors** → Make sure you're using the correct Deno version (v2.6.3+)
- **Permission errors** → Tests need `--allow-net --allow-env` flags

