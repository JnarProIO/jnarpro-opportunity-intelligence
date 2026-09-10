import { z } from "zod";

const OpportunitySchema = z.object({
  name: z.string(),
  recurringRevenue: z.boolean(),
  zeroUpfrontCost: z.boolean(),
  automationReady: z.boolean(),
  legitimateAcquisition: z.boolean(),
  scalable: z.boolean(),
  commissionRate: z.number().min(0).max(100),
});

type Opportunity = z.infer<typeof OpportunitySchema>;

function scoreOpportunity(opportunity: Opportunity): number {
  let score = 0;

  if (opportunity.recurringRevenue) score += 25;
  if (opportunity.zeroUpfrontCost) score += 20;
  if (opportunity.automationReady) score += 20;
  if (opportunity.legitimateAcquisition) score += 15;
  if (opportunity.scalable) score += 10;

  score += Math.min(opportunity.commissionRate / 10, 10);

  return Math.round(score);
}

function qualifyOpportunity(opportunity: Opportunity) {
  const validated = OpportunitySchema.parse(opportunity);
  const score = scoreOpportunity(validated);

  return {
    ...validated,
    score,
    tier: score >= 80 ? "TIER_1" : score >= 60 ? "TIER_2" : "TIER_3",
    qualified: score >= 80,
  };
}

const testOpportunity: Opportunity = {
  name: "Test Recurring SaaS",
  recurringRevenue: true,
  zeroUpfrontCost: true,
  automationReady: true,
  legitimateAcquisition: true,
  scalable: true,
  commissionRate: 30,
};

console.log(qualifyOpportunity(testOpportunity));
