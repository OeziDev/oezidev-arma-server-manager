/** Kullanıcıya olduğu gibi gösterilecek hata (yığın izi loglanmaz). */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}
