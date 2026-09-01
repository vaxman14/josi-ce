// The boundary between "being installed" and "installed".
//
// Two rules, and they are mirror images:
//
//   before completion — /api/setup/* works, everything else under /api is
//                       refused. An unconfigured installation has no accounts,
//                       so any other route would be operating without an
//                       authorization model to enforce.
//
//   after completion  — /api/setup/* returns 404 and everything else works.
//                       404 rather than 403 or a redirect: after setup those
//                       routes do not exist, and saying "forbidden" would
//                       advertise a super-admin factory that used to be there.
//
// The state is read from the database on every request rather than cached at
// boot, so a process that started mid-setup and a process that started after it
// behave identically.
import type { NextFunction, Request, Response } from 'express';
import { getSetupState, type Db } from '@josi-ce/core';

/** Paths that must answer regardless of setup state.
 *
 * Deliberately tiny and explicit. `/health` and `/ready` are mounted outside
 * `/api` and never reach this middleware; this list exists only so the
 * exception is written down somewhere a reviewer will look. */
export const SETUP_EXEMPT_PREFIXES = ['/setup'] as const;

/** Safe bootstrap endpoints needed by the setup client before an account
 * exists. Keep this exact rather than prefix-based: widening `/auth` would
 * expose login and recovery routes during setup. */
const ALWAYS_AVAILABLE_PATHS = new Set(['/auth/csrf']);

function isSetupPath(path: string): boolean {
  return SETUP_EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export function setupGate(db: Db) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let completed: boolean;
    try {
      completed = (await getSetupState(db)).completed;
    } catch {
      // The database is unreachable. Refuse rather than guess: guessing
      // "completed" would expose the application without its authorization
      // model, and guessing "not completed" would reopen the wizard.
      res.status(503).json({ error: 'this installation is not available right now' });
      return;
    }

    const setupPath = isSetupPath(req.path);

    if (ALWAYS_AVAILABLE_PATHS.has(req.path)) {
      next();
      return;
    }

    if (!completed) {
      if (setupPath) {
        next();
        return;
      }
      // Not a 404: the route genuinely exists and will work shortly. Saying so
      // is more useful to an operator than pretending it is absent, and reveals
      // nothing an unconfigured install does not already announce.
      res.status(503).json({
        error: 'this installation has not been set up yet',
        setupRequired: true,
      });
      return;
    }

    if (setupPath) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    next();
  };
}
