import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ProfileInput } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ProfilesService } from './profiles.service.js';

@Controller('profiles')
@UseGuards(JwtAuthGuard)
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.profiles.list(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.profiles.get(user.id, id);
  }

  /** Deterministic calorie + macro breakdown for the profile. */
  @Get(':id/calories')
  calories(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.profiles.calories(user.id, id);
  }

  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(ProfileInput)) dto: ProfileInput,
  ) {
    return this.profiles.create(user.id, dto);
  }

  @Put(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ProfileInput)) dto: ProfileInput,
  ) {
    return this.profiles.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.profiles.remove(user.id, id);
  }
}
