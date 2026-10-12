// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What the signed tokens of the application have in common. Each kind is
 * signed in one way and says in its audience what it is for, and whoever
 * reads a token asks for both: a token of one kind is then never taken for
 * another, whichever key signed it.
 */
export const TOKEN_ALGORITHM = 'HS256';

/** An access token: a signed-in account calling the API. */
export const ACCOUNT_AUDIENCE = 'diet-app/account';

/** The cookie of a reviewer session. */
export const REVIEWER_AUDIENCE = 'diet-app/reviewer';

/** The cookie of the administrator's session. */
export const ADMIN_AUDIENCE = 'diet-app/admin';

/** A note that a model made a pick, handed to the client with the pick and back with the request that takes it. */
export const MODEL_PICK_AUDIENCE = 'diet-app/model-pick';
