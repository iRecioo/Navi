#include <cpuid.h>
#include <stdint.h>

int main(void) {
    unsigned int eax, ebx, ecx, edx;
    if (!__get_cpuid(1, &eax, &ebx, &ecx, &edx)) return 1;
    const unsigned int required = bit_AVX | bit_OSXSAVE | bit_FMA | bit_F16C | bit_SSE4_2;
    if ((ecx & required) != required) return 1;
    unsigned int xcr0, xcr0_high;
    __asm__ volatile("xgetbv" : "=a"(xcr0), "=d"(xcr0_high) : "c"(0));
    if ((xcr0 & 6U) != 6U) return 1;
    if (!__get_cpuid_count(7, 0, &eax, &ebx, &ecx, &edx)) return 1;
    const unsigned int simd = bit_AVX2 | bit_BMI2;
    return (ebx & simd) == simd ? 0 : 1;
}
