// Shared argv helper for the CLI entry points (launch/server/wait/report).
//
// A flag's value runs until the next `--flag`, with the tokens rejoined by
// spaces. This makes unquoted paths containing spaces work — notably
// PowerShell 5.1's `Start-Process -ArgumentList`, which joins its list with
// spaces and NO re-quoting, so `--dir D:\Project\NextJS Project\web` arrives
// as three separate tokens. Truncating at the first token (the old behavior)
// silently wrote batches to a wrong directory.
export function makeArg(argv) {
  return (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1 || !argv[i + 1] || argv[i + 1].startsWith('--')) return fallback;
    const parts = [];
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) parts.push(argv[j]);
    return parts.join(' ');
  };
}
