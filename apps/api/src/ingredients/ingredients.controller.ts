import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { IngredientsService } from './ingredients.service.js';

@Controller('ingredients')
@UseGuards(JwtAuthGuard)
export class IngredientsController {
  constructor(private readonly ingredients: IngredientsService) {}

  /**
   * Search the curated ingredient database. `?ids=` resolves a specific
   * list (used by the profile page to render saved favourite/avoid entries
   * by name); `?search=` does a case-insensitive name match.
   */
  @Get()
  list(@Query('search') search?: string, @Query('ids') ids?: string) {
    if (ids) return this.ingredients.getMany(ids.split(',').filter(Boolean));
    return this.ingredients.search(search);
  }
}
