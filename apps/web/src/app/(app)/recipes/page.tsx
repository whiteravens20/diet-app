import { Soup } from 'lucide-react';
import { PagePlaceholder } from '@/components/page-placeholder';

export default function RecipesPage() {
  return (
    <PagePlaceholder
      title="Recipes"
      icon={Soup}
      description="Browse, search and filter the recipe library; manage favorites."
      endpoints={['GET /api/recipes?search=…&dietType=…', 'GET /api/recipes/:id', 'GET /api/favorites']}
    />
  );
}
