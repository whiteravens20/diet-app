import { ListChecks } from 'lucide-react';
import { PagePlaceholder } from '@/components/page-placeholder';

export default function ShoppingListsPage() {
  return (
    <PagePlaceholder
      title="Shopping lists"
      icon={ListChecks}
      description="Consolidated, aisle-grouped shopping lists generated from a meal plan."
      endpoints={[
        'POST  /api/shopping-lists/generate',
        'GET   /api/shopping-lists/:id',
        'PATCH /api/shopping-lists/:id/items/:itemId',
      ]}
    />
  );
}
