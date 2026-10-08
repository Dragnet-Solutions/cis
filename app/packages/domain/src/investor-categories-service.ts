/**
 * UX-FRM-002 — Investor categories served.
 *
 * Trivial in scope, deliberately so: a multi-select declaration on the firm's
 * own profile with ZERO effect on eligibility, scoring, or published results.
 * This file is the ONLY place that writes `organizations.investor_categories_served`.
 * No scoring, eligibility or evidence-pack code path may import from here or
 * read that column — that separation is enforced by never wiring this value
 * into any of those services, and verified by a grep-based inertness test.
 */

import { Pool } from 'pg';
import { getOrganizationById, setInvestorCategoriesServed } from '@cis/db';
import type { InvestorCategoryServed, Organization } from '@cis/shared-types';
import { DomainError } from './errors';

export class InvestorCategoriesError extends DomainError {
  constructor(message: string, code = 'INVESTOR_CATEGORIES') {
    super(message, code);
  }
}

const VALID_CATEGORIES: ReadonlySet<InvestorCategoryServed> = new Set([
  'retail',
  'local_institutional',
  'foreign_institutional',
  'not_sure',
]);

/**
 * Update a firm's investor-categories declaration. Editable at any time by
 * the firm's coordinator, same as every other firm-portal self-service
 * field — no critical action, no maker-checker, no permission beyond being
 * authenticated into the portal.
 */
export async function updateInvestorCategoriesServed(
  pool: Pool,
  organizationId: string,
  categories: InvestorCategoryServed[],
): Promise<Organization> {
  const unique = Array.from(new Set(categories));
  for (const category of unique) {
    if (!VALID_CATEGORIES.has(category)) {
      throw new InvestorCategoriesError(
        `Unknown investor category: ${category}`,
        'UNKNOWN_CATEGORY',
      );
    }
  }
  const org = await getOrganizationById(pool, organizationId);
  if (!org) {
    throw new InvestorCategoriesError('Organization not found', 'ORG_NOT_FOUND');
  }
  return setInvestorCategoriesServed(pool, organizationId, unique);
}
