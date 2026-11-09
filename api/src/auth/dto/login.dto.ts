import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  login: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password: string;
}
