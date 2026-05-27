import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ChangePasswordRequest,
  DeleteAccountRequest,
  UpdateUserSettings,
} from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { UsersService } from './users.service.js';

@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  getMe(@CurrentUser() user: RequestUser) {
    return this.users.getMe(user.id);
  }

  @Patch()
  updateSettings(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(UpdateUserSettings)) dto: UpdateUserSettings,
  ) {
    return this.users.updateSettings(user.id, dto);
  }

  @Post('password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(ChangePasswordRequest)) dto: ChangePasswordRequest,
  ) {
    await this.users.changePassword(user.id, dto);
  }

  @Delete()
  @HttpCode(204)
  async deleteAccount(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(DeleteAccountRequest)) dto: DeleteAccountRequest,
  ) {
    await this.users.deleteAccount(user.id, dto);
  }
}
