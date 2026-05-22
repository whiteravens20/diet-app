import { CalendarRange } from 'lucide-react';
import { PagePlaceholder } from '@/components/page-placeholder';

export default function MealPlansPage() {
  return (
    <PagePlaceholder
      title="Meal plans"
      icon={CalendarRange}
      description="Generate, preview and regenerate calorie-targeted meal plans."
      endpoints={[
        'POST /api/meal-plans/generate',
        'GET  /api/meal-plans?profileId=…',
        'POST /api/meal-plans/swap-meal',
        'POST /api/meal-plans/swap-ingredient/preview',
      ]}
    />
  );
}
