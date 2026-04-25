"""Unit tests for chain helper functions."""

from backend.chain import format_structured_data


class TestFormatStructuredData:
    def test_formats_product_data(self):
        items = [
            {
                "@context": "https://schema.org",
                "@type": "Product",
                "name": "Sony WH-1000XM5",
                "brand": {"@type": "Brand", "name": "Sony"},
                "offers": {
                    "@type": "Offer",
                    "price": "299.99",
                    "priceCurrency": "USD",
                },
            }
        ]
        result = format_structured_data(items)
        assert "Product" in result
        assert "Sony WH-1000XM5" in result
        assert "299.99" in result
        assert "USD" in result
        # @context should be excluded
        assert "schema.org" not in result

    def test_handles_list_type(self):
        items = [{"@type": ["Product", "IndividualProduct"], "name": "Widget"}]
        result = format_structured_data(items)
        assert "Product, IndividualProduct" in result
        assert "Widget" in result

    def test_handles_nested_arrays(self):
        items = [
            {
                "@type": "ItemList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "First"},
                    {"@type": "ListItem", "position": 2, "name": "Second"},
                ],
            }
        ]
        result = format_structured_data(items)
        assert "First" in result
        assert "Second" in result

    def test_empty_list_returns_empty_string(self):
        result = format_structured_data([])
        assert result == ""

    def test_missing_type(self):
        items = [{"name": "No type here"}]
        result = format_structured_data(items)
        assert "Unknown" in result
        assert "No type here" in result
