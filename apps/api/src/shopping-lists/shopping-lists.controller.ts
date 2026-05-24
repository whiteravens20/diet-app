import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { GenerateShoppingListRequest, UpdateShoppingItemRequest } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ShoppingListsService } from './shopping-lists.service.js';

@Controller('shopping-lists')
@UseGuards(JwtAuthGuard)
export class ShoppingListsController {
  constructor(private readonly lists: ShoppingListsService) {}

  @Post('generate')
  generate(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(GenerateShoppingListRequest)) dto: GenerateShoppingListRequest,
  ) {
    return this.lists.generate(user.id, dto);
  }

  /** Lists for one plan, newest first — drives the shopping-list page. */
  @Get()
  list(@CurrentUser() user: RequestUser, @Query('planId') planId: string) {
    return this.lists.listForPlan(user.id, planId);
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.lists.get(user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.lists.remove(user.id, id);
  }

  @Patch(':id/items/:itemId')
  updateItem(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(UpdateShoppingItemRequest)) dto: UpdateShoppingItemRequest,
  ) {
    return this.lists.updateItem(user.id, id, itemId, dto);
  }
}
