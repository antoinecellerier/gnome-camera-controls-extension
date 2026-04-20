// SPDX-License-Identifier: GPL-3.0-or-later
//
// ESLint flat config. Lints the GJS sources that run inside gnome-shell
// (extension.js, indicator.js, ...) and inside the prefs process (prefs.js),
// plus the out-of-process WirePlumber helper (camera-monitor-helper.js).
//
// Globals cover the GJS runtime surface: `print`/`printerr` from the module
// scope, `log`/`logError` injected by gnome-shell, the web-platform `Text*`
// codecs and timer APIs that GJS exposes, and `imports`/`global` for the
// legacy surface that some reviewers still expect to be recognized.

import js from '@eslint/js';
import globals from 'globals';

const gjsGlobals = {
    ...globals.es2022,
    print: 'readonly',
    printerr: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    imports: 'readonly',
    global: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    globalThis: 'readonly',
};

export default [
    {
        ignores: ['node_modules/**', 'schemas/gschemas.compiled', '*.zip'],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',
            }],
            'no-empty': ['error', {allowEmptyCatch: true}],
            'no-undef': 'error',
        },
    },
];
