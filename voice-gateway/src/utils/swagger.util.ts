import { OpenAPIV3 } from 'openapi-types';
import { getControllerMetadata, getMethodMetadata } from './swagger.decorators';

export interface SwaggerMetadata {
  operation: { summary: string; description?: string };
  method: string;
  path: string;
  params: Array<{ name: string; type: string; required: boolean }>;
  queries: Array<{ name: string; type: string; required: boolean }>;
  body?: { description: string; schema: Record<string, any> };
  responses: Array<{ statusCode: string; description: string; schema?: any }>;
  tags?: string[];
  security?: any[];
}

export interface ControllerMetadata {
  basePath: string;
  tags: string[];
  security?: any[];
}

// Simple schema registry
export class SchemaRegistry {
  private static schemas: Record<string, any> = {};

  static registerSchema(name: string, schema: any) {
    this.schemas[name] = schema;
  }

  static getSchemas(): Record<string, any> {
    return { ...this.schemas };
  }

  static clear() {
    this.schemas = {};
  }
}

export const generateSwaggerSpec = (controllers: any[]): OpenAPIV3.Document => {
  const paths: OpenAPIV3.PathsObject = {};
  const tags: OpenAPIV3.TagObject[] = [];
  
  // Get schemas from the registry
  const schemas = SchemaRegistry.getSchemas();
  
  const components: OpenAPIV3.ComponentsObject = {
    schemas,
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT'
      }
    }
  };

  controllers.forEach((ControllerClass) => {
    const instance = new ControllerClass();
    const ctrlMeta = getControllerMetadata(ControllerClass);
    const basePath = ctrlMeta.basePath || '';
    const controllerTags = ctrlMeta.tags || [];
    
    // Add controller tags
    controllerTags.forEach((tag: string) => {
      if (!tags.find(t => t.name === tag)) {
        tags.push({ name: tag, description: `${tag} operations` });
      }
    });

    const prototype = Object.getPrototypeOf(instance);
    
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (key === 'constructor') continue;

      const metadata = getMethodMetadata(prototype, key);

      if (!metadata.operation?.summary || !metadata.method || metadata.path === undefined) continue;

      const fullPath = `${basePath}${metadata.path}`;
      paths[fullPath] = paths[fullPath] || {};

      // Build parameters
      const parameters: OpenAPIV3.ParameterObject[] = [
        ...metadata.params.map((param: any) => ({
          name: param.name,
          in: 'path' as const,
          required: param.required,
          schema: { type: param.type as any },
          description: param.description || `Path parameter: ${param.name}`
        })),
        ...metadata.queries.map((query: any) => ({
          name: query.name,
          in: 'query' as const,
          required: query.required,
          schema: { type: query.type as any },
          description: query.description || `Query parameter: ${query.name}`
        }))
      ];

      // Build request body
      const requestBody: OpenAPIV3.RequestBodyObject | undefined = metadata.body
        ? {
            description: metadata.body.description,
            required: true,
            content: {
              'application/json': {
                schema: metadata.body.schema
              }
            }
          }
        : undefined;

      // Build responses
      const responses: OpenAPIV3.ResponsesObject = metadata.responses.reduce((acc: any, response: any) => {
        const responseContent = response.schema
          ? { 'application/json': { schema: response.schema } }
          : undefined;
        
        acc[response.statusCode] = {
          description: response.description,
          ...(responseContent && { content: responseContent })
        };
        return acc;
      }, {} as OpenAPIV3.ResponsesObject);

      // Build operation object
      const operation: OpenAPIV3.OperationObject = {
        summary: metadata.operation.summary,
        ...(metadata.operation.description && { description: metadata.operation.description }),
        ...(metadata.tags && metadata.tags.length > 0 && { tags: metadata.tags }),
        parameters,
        ...(requestBody && { requestBody }),
        responses,
        ...(metadata.security && { security: metadata.security })
      };

      // Add operation to path
      (paths[fullPath] as any)[metadata.method.toLowerCase()] = operation;
    }
  });

  return {
    openapi: '3.0.3',
    info: {
      title: 'API Documentation',
      version: '1.0.0',
      description: 'Comprehensive API Documentation generated using decorators',
      contact: {
        name: 'API Support',
        email: 'support@example.com'
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT'
      }
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Local Development' },
      { url: 'https://api.example.com', description: 'Production' }
    ],
    paths,
    components,
    tags,
    security: [{ bearerAuth: [] }]
  };
};
