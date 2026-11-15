//! A tiny, dependency-free JSON reader/writer for the agent control protocol.
//!
//! The agent deliberately ships with no third-party crates (see `agent/README.md`)
//! so it builds from source on any target with only a Rust toolchain. That means
//! the handful of JSON values the control protocol exchanges are handled here.
//!
//! This is intentionally a strict subset of JSON: objects, arrays, strings,
//! numbers, booleans, and null. Anything malformed is rejected with a position
//! instead of being coerced, so a buggy peer fails loudly.

use std::collections::BTreeMap;
use std::fmt;

/// A JSON value. Objects use `BTreeMap` so encoded output has a stable key order.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    /// A number literal kept verbatim because an `f64` cannot represent it
    /// exactly (e.g. a 64-bit request id). Re-encoded byte-for-byte (SAA-328).
    RawNumber(String),
    String(String),
    Array(Vec<Value>),
    Object(BTreeMap<String, Value>),
}

impl Value {
    /// Build a `Value::String` from anything string-like.
    pub fn string(value: impl Into<String>) -> Value {
        Value::String(value.into())
    }

    /// Build a `Value::Object` from a short list of key/value pairs.
    pub fn object(entries: Vec<(&str, Value)>) -> Value {
        Value::Object(entries.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
    }

    /// Look up a member of an object; returns `None` for non-objects.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(map) => map.get(key),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(value) => Some(*value),
            Value::RawNumber(text) => text.parse().ok(),
            _ => None,
        }
    }

    /// An integral number that fits an `i64` exactly, or `None`.
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Number(value) if value.fract() == 0.0 && value.abs() < 9.0e15 => Some(*value as i64),
            Value::RawNumber(text) => text.parse().ok(),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    /// Serialize to a compact single-line JSON document (no trailing newline).
    pub fn encode(&self) -> String {
        let mut out = String::new();
        self.write_to(&mut out);
        out
    }

    fn write_to(&self, out: &mut String) {
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(true) => out.push_str("true"),
            Value::Bool(false) => out.push_str("false"),
            Value::Number(number) if number.is_finite() => out.push_str(&format_number(*number)),
            // JSON has no representation for NaN or infinity; emit null.
            Value::Number(_) => out.push_str("null"),
            Value::RawNumber(text) => out.push_str(text),
            Value::String(text) => write_string(text, out),
            Value::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.write_to(out);
                }
                out.push(']');
            }
            Value::Object(map) => {
                out.push('{');
                for (index, (key, value)) in map.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_string(key, out);
                    out.push(':');
                    value.write_to(out);
                }
                out.push('}');
            }
        }
    }
}

fn format_number(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 9.0e15 {
        (number as i64).to_string()
    } else {
        number.to_string()
    }
}

fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            control if (control as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", control as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
}

/// A parse failure with the character offset where it was detected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonError {
    message: String,
    position: usize,
}

impl JsonError {
    fn new(message: impl Into<String>, position: usize) -> JsonError {
        JsonError { message: message.into(), position }
    }

    /// The 0-based character offset at which parsing failed.
    pub fn position(&self) -> usize {
        self.position
    }
}

impl fmt::Display for JsonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} at character {}", self.message, self.position)
    }
}

impl std::error::Error for JsonError {}

/// Maximum nesting of arrays/objects accepted by [`decode`]. The parser is
/// recursive, so without a cap a hostile peer could overflow the stack with a
/// line like `[[[[...` and crash the persistent agent (SAA-325).
pub const MAX_DEPTH: usize = 128;

/// Parse a complete JSON document. Trailing whitespace is allowed; trailing
/// content is not.
pub fn decode(input: &str) -> Result<Value, JsonError> {
    let characters: Vec<char> = input.chars().collect();
    let mut parser = Parser { characters: &characters, position: 0, depth: 0 };
    parser.skip_whitespace();
    let value = parser.parse_value()?;
    parser.skip_whitespace();
    if parser.position < parser.characters.len() {
        return Err(JsonError::new("unexpected trailing characters", parser.position));
    }
    Ok(value)
}

struct Parser<'a> {
    characters: &'a [char],
    position: usize,
    depth: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<char> {
        self.characters.get(self.position).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let character = self.peek();
        if character.is_some() {
            self.position += 1;
        }
        character
    }

    fn skip_whitespace(&mut self) {
        while let Some(character) = self.peek() {
            if character == ' ' || character == '\t' || character == '\n' || character == '\r' {
                self.position += 1;
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self) -> Result<Value, JsonError> {
        match self.peek() {
            Some('{') => self.nested(Parser::parse_object),
            Some('[') => self.nested(Parser::parse_array),
            Some('"') => Ok(Value::String(self.parse_string()?)),
            Some('t') | Some('f') => self.parse_bool(),
            Some('n') => self.parse_null(),
            Some(character) if character == '-' || character.is_ascii_digit() => self.parse_number(),
            Some(character) => Err(JsonError::new(format!("unexpected character '{character}'"), self.position)),
            None => Err(JsonError::new("unexpected end of input", self.position)),
        }
    }

    /// Run a container parser one nesting level deeper, refusing past [`MAX_DEPTH`].
    fn nested(&mut self, parse: fn(&mut Parser<'a>) -> Result<Value, JsonError>) -> Result<Value, JsonError> {
        if self.depth >= MAX_DEPTH {
            return Err(JsonError::new(format!("nesting deeper than {MAX_DEPTH} levels"), self.position));
        }
        self.depth += 1;
        let result = parse(self);
        self.depth -= 1;
        result
    }

    fn parse_object(&mut self) -> Result<Value, JsonError> {
        self.bump(); // '{'
        let mut map = BTreeMap::new();
        self.skip_whitespace();
        if self.peek() == Some('}') {
            self.bump();
            return Ok(Value::Object(map));
        }
        loop {
            self.skip_whitespace();
            if self.peek() != Some('"') {
                return Err(JsonError::new("expected a string object key", self.position));
            }
            let key = self.parse_string()?;
            self.skip_whitespace();
            if self.bump() != Some(':') {
                return Err(JsonError::new("expected ':' after object key", self.position.saturating_sub(1)));
            }
            self.skip_whitespace();
            let value = self.parse_value()?;
            map.insert(key, value);
            self.skip_whitespace();
            match self.bump() {
                Some(',') => continue,
                Some('}') => break,
                Some(character) => {
                    return Err(JsonError::new(format!("expected ',' or '}}', found '{character}'"), self.position.saturating_sub(1)))
                }
                None => return Err(JsonError::new("unterminated object", self.position)),
            }
        }
        Ok(Value::Object(map))
    }

    fn parse_array(&mut self) -> Result<Value, JsonError> {
        self.bump(); // '['
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(']') {
            self.bump();
            return Ok(Value::Array(items));
        }
        loop {
            self.skip_whitespace();
            items.push(self.parse_value()?);
            self.skip_whitespace();
            match self.bump() {
                Some(',') => continue,
                Some(']') => break,
                Some(character) => {
                    return Err(JsonError::new(format!("expected ',' or ']', found '{character}'"), self.position.saturating_sub(1)))
                }
                None => return Err(JsonError::new("unterminated array", self.position)),
            }
        }
        Ok(Value::Array(items))
    }

    fn parse_string(&mut self) -> Result<String, JsonError> {
        if self.bump() != Some('"') {
            return Err(JsonError::new("expected a string", self.position));
        }
        let mut out = String::new();
        loop {
            let character = match self.bump() {
                Some(character) => character,
                None => return Err(JsonError::new("unterminated string", self.position)),
            };
            match character {
                '"' => return Ok(out),
                '\\' => {
                    let escape = self.bump().ok_or_else(|| JsonError::new("unterminated escape", self.position))?;
                    match escape {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{08}'),
                        'f' => out.push('\u{0c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => out.push(self.parse_unicode_escape()?),
                        other => return Err(JsonError::new(format!("invalid escape '\\{other}'"), self.position.saturating_sub(1))),
                    }
                }
                control if (control as u32) < 0x20 => {
                    return Err(JsonError::new("unescaped control character in string", self.position.saturating_sub(1)))
                }
                other => out.push(other),
            }
        }
    }

    fn parse_unicode_escape(&mut self) -> Result<char, JsonError> {
        let unit = self.parse_hex4()?;
        if (0xD800..0xDC00).contains(&unit) {
            // High surrogate: a following `\uXXXX` low surrogate completes the code point.
            if self.bump() != Some('\\') || self.bump() != Some('u') {
                return Err(JsonError::new("lone high surrogate in \\u escape", self.position));
            }
            let low = self.parse_hex4()?;
            if !(0xDC00..0xE000).contains(&low) {
                return Err(JsonError::new("invalid low surrogate in \\u escape", self.position));
            }
            let code_point = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
            char::from_u32(code_point).ok_or_else(|| JsonError::new("invalid unicode code point", self.position))
        } else if (0xDC00..0xE000).contains(&unit) {
            Err(JsonError::new("lone low surrogate in \\u escape", self.position))
        } else {
            char::from_u32(unit).ok_or_else(|| JsonError::new("invalid unicode code point", self.position))
        }
    }

    fn parse_hex4(&mut self) -> Result<u32, JsonError> {
        let mut value = 0u32;
        for _ in 0..4 {
            let character = self.bump().ok_or_else(|| JsonError::new("truncated \\u escape", self.position))?;
            let digit = character.to_digit(16).ok_or_else(|| JsonError::new("invalid hex digit in \\u escape", self.position.saturating_sub(1)))?;
            value = value * 16 + digit;
        }
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<Value, JsonError> {
        let start = self.position;
        if self.peek() == Some('-') {
            self.bump();
        }
        match self.peek() {
            Some('0') => {
                self.bump();
            }
            Some(character) if character.is_ascii_digit() => {
                while matches!(self.peek(), Some(next) if next.is_ascii_digit()) {
                    self.bump();
                }
            }
            _ => return Err(JsonError::new("invalid number", start)),
        }
        if self.peek() == Some('.') {
            self.bump();
            if !matches!(self.peek(), Some(next) if next.is_ascii_digit()) {
                return Err(JsonError::new("invalid number fraction", self.position));
            }
            while matches!(self.peek(), Some(next) if next.is_ascii_digit()) {
                self.bump();
            }
        }
        if matches!(self.peek(), Some('e') | Some('E')) {
            self.bump();
            if matches!(self.peek(), Some('+') | Some('-')) {
                self.bump();
            }
            if !matches!(self.peek(), Some(next) if next.is_ascii_digit()) {
                return Err(JsonError::new("invalid number exponent", self.position));
            }
            while matches!(self.peek(), Some(next) if next.is_ascii_digit()) {
                self.bump();
            }
        }
        let text: String = self.characters[start..self.position].iter().collect();
        let number = text.parse::<f64>().map_err(|_| JsonError::new("invalid number", start))?;
        // Keep the literal when the f64 would not re-encode to the same text,
        // so large ids and long decimals are echoed exactly (SAA-328).
        if number.is_finite() && format_number(number) == text {
            Ok(Value::Number(number))
        } else {
            Ok(Value::RawNumber(text))
        }
    }

    fn parse_bool(&mut self) -> Result<Value, JsonError> {
        if self.consume_keyword("true") {
            Ok(Value::Bool(true))
        } else if self.consume_keyword("false") {
            Ok(Value::Bool(false))
        } else {
            Err(JsonError::new("invalid literal", self.position))
        }
    }

    fn parse_null(&mut self) -> Result<Value, JsonError> {
        if self.consume_keyword("null") {
            Ok(Value::Null)
        } else {
            Err(JsonError::new("invalid literal", self.position))
        }
    }

    fn consume_keyword(&mut self, keyword: &str) -> bool {
        let keyword: Vec<char> = keyword.chars().collect();
        if self.characters[self.position..].starts_with(keyword.as_slice()) {
            self.position += keyword.len();
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_decodes_nested_values() {
        let value = Value::object(vec![
            ("op", Value::string("fs.list")),
            ("id", Value::Number(7.0)),
            ("ok", Value::Bool(true)),
            ("missing", Value::Null),
            ("entries", Value::Array(vec![Value::string("a"), Value::Number(1.5)])),
        ]);
        let encoded = value.encode();
        assert_eq!(encoded, "{\"entries\":[\"a\",1.5],\"id\":7,\"missing\":null,\"ok\":true,\"op\":\"fs.list\"}");
        assert_eq!(decode(&encoded), Ok(value));
    }

    #[test]
    fn escapes_control_and_quote_characters() {
        let value = Value::string("line\n\"quote\"\ttab\u{1}");
        assert_eq!(value.encode(), "\"line\\n\\\"quote\\\"\\ttab\\u0001\"");
        assert_eq!(decode(&value.encode()), Ok(value));
    }

    #[test]
    fn decodes_unicode_escapes_and_surrogate_pairs() {
        assert_eq!(decode("\"\\u0041\""), Ok(Value::string("A")));
        assert_eq!(decode("\"\\ud83d\\ude00\""), Ok(Value::string("😀")));
    }

    #[test]
    fn rejects_malformed_input() {
        assert!(decode("").is_err());
        assert!(decode("{").is_err());
        assert!(decode("{\"a\":1,}").is_err());
        assert!(decode("[1 2]").is_err());
        assert!(decode("truex").is_err());
        assert!(decode("01").is_err());
        assert!(decode("\"\\ud83d\"").is_err());
    }

    #[test]
    fn rejects_excessive_nesting_without_overflowing_the_stack() {
        // SAA-325: this used to recurse until the stack overflowed.
        let hostile = "[".repeat(1_000_000);
        let error = decode(&hostile).unwrap_err();
        assert!(error.to_string().contains("nesting deeper than"), "{error}");
        let objects = "{\"a\":".repeat(100_000);
        assert!(decode(&objects).is_err());

        let at_limit = format!("{}{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
        assert!(decode(&at_limit).is_ok());
        let over = format!("{}{}", "[".repeat(MAX_DEPTH + 1), "]".repeat(MAX_DEPTH + 1));
        assert!(decode(&over).is_err());
    }

    #[test]
    fn large_and_precise_numbers_round_trip_exactly() {
        // SAA-328: these used to come back rounded through f64.
        for literal in ["9007199254740993", "12345678901234567890", "-9223372036854775808", "0.1000000000000000055511151231257827", "1e400"] {
            assert_eq!(decode(literal).unwrap().encode(), literal);
        }
        let request = decode("{\"id\":9007199254740993,\"op\":\"ping\"}").unwrap();
        assert_eq!(request.get("id").and_then(Value::as_i64), Some(9_007_199_254_740_993));
        assert_eq!(request.encode(), "{\"id\":9007199254740993,\"op\":\"ping\"}");
        // Ordinary numbers still decode to plain f64 values.
        assert_eq!(decode("7"), Ok(Value::Number(7.0)));
        assert_eq!(decode("1.5"), Ok(Value::Number(1.5)));
    }

    #[test]
    fn non_finite_numbers_encode_as_null() {
        assert_eq!(Value::Number(f64::NAN).encode(), "null");
        assert_eq!(Value::Number(f64::INFINITY).encode(), "null");
    }
}
