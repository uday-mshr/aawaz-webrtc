import { SchemaRegistry } from './swagger.util';

/**
 * Simple schema loader that registers schemas directly
 * @param schemas - Object containing schema name to schema mapping
 * @example
 * loadSchemas({
 *   'User': { type: 'object', properties: { id: { type: 'string' } } },
 *   'LoginRequest': { type: 'object', properties: { email: { type: 'string' } } }
 * });
 */
export const loadSchemas = (schemas: Record<string, any>) => {
  try {
    console.log('Loading schemas...');
    
    Object.entries(schemas).forEach(([name, schema]) => {
      SchemaRegistry.registerSchema(name, schema);
      console.log(`  Registered schema: ${name}`);
    });
    
    const registeredSchemas = SchemaRegistry.getSchemas();
    console.log(`Successfully loaded ${Object.keys(registeredSchemas).length} schemas:`, Object.keys(registeredSchemas));
    
  } catch (error) {
    console.error('Error loading schemas:', error);
  }
};

/**
 * Load schemas from decorated classes
 * @param classes - Array of decorated classes to extract schemas from
 * @example
 * loadSchemasFromClasses([User, LoginRequest, AuthResponse]);
 */
export const loadSchemasFromClasses = (classes: any[]) => {
  try {
    console.log('Loading schemas from decorated classes...');
    
    classes.forEach((Class) => {
      if (typeof Class === 'function' && Class.prototype) {
        const className = Class.name;
        
        // Get metadata from the class
        const schemaMetadata = Reflect.getMetadata('swagger:schema', Class);
        const propertiesMetadata = Reflect.getMetadata('swagger:properties', Class);
        const requiredMetadata = Reflect.getMetadata('swagger:required', Class);
        
        if (schemaMetadata || propertiesMetadata) {
          // Build the schema object
          const schema: any = {
            type: 'object',
            ...(schemaMetadata?.description && { description: schemaMetadata.description }),
            ...(schemaMetadata?.example && { example: schemaMetadata.example })
          };
          
          // Add properties if they exist
          if (propertiesMetadata) {
            schema.properties = propertiesMetadata;
          }
          
          // Add required fields if they exist
          if (requiredMetadata && requiredMetadata.length > 0) {
            schema.required = requiredMetadata;
          }
          
          // Register the schema
          SchemaRegistry.registerSchema(className, schema);
          console.log(`  Registered schema for ${className}`);
        }
      }
    });
    
    const registeredSchemas = SchemaRegistry.getSchemas();
    console.log(`Successfully loaded ${Object.keys(registeredSchemas).length} schemas from classes`);
    
  } catch (error) {
    console.error('Error loading schemas from classes:', error);
  }
};

/**
 * Clear all registered schemas
 */
export const clearSchemas = () => {
  SchemaRegistry.clear();
  console.log('All schemas cleared');
};

// Export the main function as default
export default loadSchemas;
