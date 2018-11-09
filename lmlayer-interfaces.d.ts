/**
 * Interfaces and types specific to the LMLayer and its consumers.
 */
type Weight = number;

 /**
  * TODO: ...
  */
interface Model {
  readonly configuration: Configuration;
  predict(...args: any): InternalSuggestion[];
}

/**
 * TODO: ...
 */
interface InternalSuggestion {
  transform: Transform;
  displayAs?: string;
  weight: Weight;
}