import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApplyFavoriteSetRequest,
  CreateFavoriteSetRequest,
  UpdateFavoriteSetRequest,
  type Locale,
} from '@diet-app/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { FavoriteSetsService } from './favorite-sets.service.js';

@Controller('favorite-sets')
@UseGuards(JwtAuthGuard)
export class FavoriteSetsController {
  constructor(private readonly sets: FavoriteSetsService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query('profileId') profileId: string) {
    return this.sets.list(user.id, profileId);
  }

  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(CreateFavoriteSetRequest)) dto: CreateFavoriteSetRequest,
  ) {
    return this.sets.create(user.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateFavoriteSetRequest)) dto: UpdateFavoriteSetRequest,
  ) {
    return this.sets.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<void> {
    await this.sets.remove(user.id, id);
  }

  @Post(':id/apply')
  apply(
    @CurrentUser() user: RequestUser,
    @RequestLocale() locale: Locale,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ApplyFavoriteSetRequest)) dto: ApplyFavoriteSetRequest,
  ) {
    return this.sets.apply(user.id, locale, id, dto);
  }
}
