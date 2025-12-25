import 'reflect-metadata';

// Core metadata keys
const METADATA_KEYS = {
  CONTROLLER: 'swagger:controller',
  OPERATION: 'swagger:operation',
  METHOD: 'swagger:method',
  PATH: 'swagger:path',
  PARAMS: 'swagger:params',
  QUERIES: 'swagger:queries',
  BODY: 'swagger:body',
  RESPONSES: 'swagger:responses',
  TAGS: 'swagger:tags',
  SECURITY: 'swagger:security'
} as const;

// Type definitions
export interface SwaggerOperation {
  summary: string;
  description?: string;
  deprecated?: boolean;
}

export interface SwaggerParam {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
}

export interface SwaggerBody {
  description: string;
  schema: Record<string, any>;
  required?: boolean;
}

export interface SwaggerResponse {
  statusCode: string;
  description: string;
  schema?: Record<string, any>;
}

// Controller decorators
export const ApiController = (basePath: string, tags: string[] = []) => {
  return (target: any) => {
    Reflect.defineMetadata(METADATA_KEYS.CONTROLLER, { basePath, tags }, target);
  };
};

export const ApiTags = (...tags: string[]) => {
  return (target: any) => {
    Reflect.defineMetadata(METADATA_KEYS.TAGS, tags, target);
  };
};

// HTTP method decorators
export const Get = (path: string = '') => {
  return (target: any, propertyKey: string) => {
    Reflect.defineMetadata(METADATA_KEYS.METHOD, 'get', target, propertyKey);
    Reflect.defineMetadata(METADATA_KEYS.PATH, path, target, propertyKey);
  };
};

export const Post = (path: string = '') => {
  return (target: any, propertyKey: string) => {
    Reflect.defineMetadata(METADATA_KEYS.METHOD, 'post', target, propertyKey);
    Reflect.defineMetadata(METADATA_KEYS.PATH, path, target, propertyKey);
  };
};

export const Put = (path: string = '') => {
  return (target: any, propertyKey: string) => {
    Reflect.defineMetadata(METADATA_KEYS.METHOD, 'put', target, propertyKey);
    Reflect.defineMetadata(METADATA_KEYS.PATH, path, target, propertyKey);
  };
};

export const Patch = (path: string = '') => {
  return (target: any, propertyKey: string) => {
    Reflect.defineMetadata(METADATA_KEYS.METHOD, 'patch', target, propertyKey);
    Reflect.defineMetadata(METADATA_KEYS.PATH, path, target, propertyKey);
  };
};

export const Delete = (path: string = '') => {
  return (target: any, propertyKey: string) => {
    Reflect.defineMetadata(METADATA_KEYS.METHOD, 'delete', target, propertyKey);
    Reflect.defineMetadata(METADATA_KEYS.PATH, path, target, propertyKey);
  };
};

// Operation decorators
export const ApiOperation = (options: SwaggerOperation) => {
  return (target: any, propertyKey: string) => {
    Reflect.defineMetadata(METADATA_KEYS.OPERATION, options, target, propertyKey);
  };
};

export const ApiParam = (options: SwaggerParam) => {
  return (target: any, propertyKey: string) => {
    const params = Reflect.getMetadata(METADATA_KEYS.PARAMS, target, propertyKey) || [];
    params.push(options);
    Reflect.defineMetadata(METADATA_KEYS.PARAMS, params, target, propertyKey);
  };
};

export const ApiQuery = (options: SwaggerParam) => {
  return (target: any, propertyKey: string) => {
    const queries = Reflect.getMetadata(METADATA_KEYS.QUERIES, target, propertyKey) || [];
    queries.push(options);
    Reflect.defineMetadata(METADATA_KEYS.QUERIES, queries, target, propertyKey);
  };
};

export const ApiBody = (options: SwaggerBody) => {
  return (target: any, propertyKey: string) => {
    Reflect.defineMetadata(METADATA_KEYS.BODY, options, target, propertyKey);
  };
};

export const ApiResponse = (options: SwaggerResponse) => {
  return (target: any, propertyKey: string) => {
    const responses = Reflect.getMetadata(METADATA_KEYS.RESPONSES, target, propertyKey) || [];
    responses.push(options);
    Reflect.defineMetadata(METADATA_KEYS.RESPONSES, responses, target, propertyKey);
  };
};

export const ApiSecurity = (name: string, scopes?: string[]) => {
  return (target: any, propertyKey: string) => {
    Reflect.defineMetadata(METADATA_KEYS.SECURITY, [{ [name]: scopes || [] }], target, propertyKey);
  };
};

// Utility functions for metadata extraction
export const getControllerMetadata = (target: any) => {
  return Reflect.getMetadata(METADATA_KEYS.CONTROLLER, target) || {};
};

export const getMethodMetadata = (target: any, propertyKey: string) => {
  return {
    operation: Reflect.getMetadata(METADATA_KEYS.OPERATION, target, propertyKey),
    method: Reflect.getMetadata(METADATA_KEYS.METHOD, target, propertyKey),
    path: Reflect.getMetadata(METADATA_KEYS.PATH, target, propertyKey),
    params: Reflect.getMetadata(METADATA_KEYS.PARAMS, target, propertyKey) || [],
    queries: Reflect.getMetadata(METADATA_KEYS.QUERIES, target, propertyKey) || [],
    body: Reflect.getMetadata(METADATA_KEYS.BODY, target, propertyKey),
    responses: Reflect.getMetadata(METADATA_KEYS.RESPONSES, target, propertyKey) || [],
    security: Reflect.getMetadata(METADATA_KEYS.SECURITY, target, propertyKey),
    tags: Reflect.getMetadata(METADATA_KEYS.TAGS, target, propertyKey)
  };
};

export { METADATA_KEYS };
