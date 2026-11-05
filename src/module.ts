// oxlint-disable typescript/no-extraneous-class -- module classes are containers
import { Module, token, type DynamicModule, type Token } from "@usevibejs/server";
import { Storage, type StorageOptions } from "./storage.ts";

/** Inject this to store objects. */
export const STORAGE: Token<Storage> = token<Storage>("STORAGE");

export type StorageModuleOptions = StorageOptions;

/** Provides `Storage`. Import `StorageModule.forRoot({ driver, maxBytes, maxFiles, types })`. */
@Module({})
export class StorageModule {
  static forRoot(options: StorageModuleOptions): DynamicModule {
    return {
      module: StorageModule,
      global: true,
      providers: [{ provide: STORAGE, useValue: new Storage(options) }],
      exports: [STORAGE],
    };
  }
}
