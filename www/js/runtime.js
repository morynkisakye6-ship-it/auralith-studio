/* Auralith Studio runtime guard and diagnostics.
 * Kept separate from studio orchestration so input throttling and command
 * observability can be tested independently of the DOM-heavy studio controller.
 * Legacy th* names are retained as compatibility bridges for existing inline UI.
 */
(function (root) {
  'use strict';
  const host = root.window || root;
  const tapTimes = host.__thCommandTapAt || Object.create(null);
  host.__thCommandTapAt = tapTimes;
  host.__thLastCommand = host.__thLastCommand || null;

  function allowCommandTap(name, windowMs = 300) {
    if (typeof name !== 'string' || !name.trim()) return false;
    const now = Date.now();
    const last = tapTimes[name] || 0;
    if (now - last < Math.max(0, Number(windowMs) || 0)) return false;
    tapTimes[name] = now;
    return true;
  }

  function recordCommand(name) {
    if (typeof name !== 'string' || !name.trim()) return null;
    const entry = Object.freeze({ name, at: Date.now() });
    host.__thLastCommand = entry;
    return entry;
  }

  host.thAllowCommandTap = allowCommandTap;
  host.thRecordCommand = recordCommand;
  host.AuralithRuntime = Object.freeze({ allowCommandTap, recordCommand });
  host.__thProfileTriggerBound = false;
  host.__thSidebarBridgeBound = false;
  host.__thStudioToolsBound = false;
  host.__thAuthModalBound = false;
})(typeof globalThis !== 'undefined' ? globalThis : this);
