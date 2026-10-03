// Conductor progress mod: placeholder module.
//
// Claude Code calls `register` once when the plugin loads. This scaffold only
// proves that the module loads and is analysed by `claude plugin validate`; the
// progress bars, commands and sounds are added in later tasks of the track.
export function register(on: any) {
  // Runs when the session starts. Writing to the debug log keeps it invisible
  // to users, and `next(e)` lets the session start as usual.
  on('session.start', async ($: any, e: any, next: any) => {
    $.ui.log('conductor progress mod loaded', { to: 'debug' })
    return next(e)
  })
}
