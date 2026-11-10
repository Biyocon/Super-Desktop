// Git Bash seeds its own PATH before an inherited Windows PATH. Put the
// fixture directory first inside the interpreter, not just in spawn's env.
// Source in that same process so a second shell cannot reorder it again.
export function posixFixtureArgs(script, bin, args = [], requiredTools = []) {
  if (process.platform !== "win32") return [script, ...args];
  return ["-c", [
    'fixture_bin=$(cygpath -u "$1") || exit 125',
    'shift',
    'export PATH="$fixture_bin:$PATH"',
    ...requiredTools.map((tool) => `[ "$(command -v ${tool})" = "$fixture_bin/${tool}" ] || exit 125`),
    'script=$1',
    'shift',
    '. "$script" "$@"',
  ].join("\n"), "fixture", bin, script, ...args];
}
