import { Pressable, Text, View } from "react-native";
import { useMobileTokens } from "../lib/native";
import type { NativeSegmentedControlProps } from "../lib/native-controls";

/** The pre-native segmented control, kept for Android and for an empty selection. */
export function SegmentedPills<T extends string>({
  accessibilityLabel,
  value,
  onChange,
  options,
  disabled = false,
}: NativeSegmentedControlProps<T>) {
  const tokens = useMobileTokens();
  return (
    <View accessibilityLabel={accessibilityLabel} style={{ flexDirection: "row", gap: 8 }}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={{
              flex: 1,
              alignItems: "center",
              borderWidth: 1,
              borderColor: selected ? tokens.mutedForeground : tokens.border,
              backgroundColor: selected ? tokens.muted : "transparent",
              borderRadius: 11,
              paddingVertical: 12,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <Text style={{ color: selected ? tokens.foreground : tokens.mutedForeground }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
